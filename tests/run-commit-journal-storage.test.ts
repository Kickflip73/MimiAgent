import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCommitJournal, runAnswerDigest, runCommitJournalId } from '../src/core/run-commit-journal.js';

function legacyEntry(runId: string, phase: 'prepared' | 'finalized' = 'prepared') {
  return { id: runCommitJournalId('owner', runId), sessionId: 'owner', runId, executionKey: 'task:legacy',
    phase, answerDigest: runAnswerDigest(runId), runtimeActions: [], updatedAt: '2026-10-09T01:00:00.000Z' };
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mimi-commit-storage-'));
  return { directory, file: path.join(directory, 'journal.json') };
}

function worker(file: string, id: string): Promise<void> {
  const source = `import {RunCommitJournal,runAnswerDigest} from ${JSON.stringify(new URL('../src/core/run-commit-journal.ts', import.meta.url).href)};
    const journal=new RunCommitJournal(${JSON.stringify(file)});
    await journal.prepare({sessionId:'owner',runId:${JSON.stringify(id)},executionKey:'task:parallel',answerDigest:runAnswerDigest(${JSON.stringify(id)}),runtimeActions:[]});
    await journal.advance('owner',${JSON.stringify(id)},'receipt_committed');
    await journal.advance('owner',${JSON.stringify(id)},'effects_applied');`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`worker failed ${code}: ${stderr}`)));
  });
}

test('concurrent first import retains all legacy phases and independent process writes', async () => {
  const { directory, file } = await fixture();
  try {
    const entries = [legacyEntry('old-open'), legacyEntry('old-finalized', 'finalized')];
    const source = JSON.stringify({ version: 1, entries: Object.fromEntries(entries.map(entry => [entry.id, entry])) });
    await writeFile(file, source, { mode: 0o600 });
    const before = await stat(file);
    const workers = await Promise.allSettled(['a', 'b', 'c'].map(id => worker(file, id)));
    for (const result of workers) if (result.status === 'rejected') throw result.reason;
    const journal = new RunCommitJournal(file);
    assert.equal(await readFile(file, 'utf8'), source);
    assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
    for (const id of ['a', 'b', 'c']) assert.equal((await journal.get('owner', id))?.phase, 'effects_applied');
    assert.equal((await journal.get('owner', 'old-finalized'))?.phase, 'finalized');
    assert.equal((await journal.recoverable()).length, 4);
    const db = new DatabaseSync(`${file}.sqlite`, { readOnly: true });
    try {
      const marker = JSON.parse(String(db.prepare("SELECT value FROM journal_meta WHERE key='legacy_import'").get()?.value));
      assert.equal(marker.entries, 2);
      assert.equal(marker.sourceDigest, runAnswerDigest(source));
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM run_commits').get()?.count, 5);
    } finally { db.close(); }
    await journal.finalizeExecution('owner', 'task:parallel');
    assert.deepEqual((await journal.recoverable()).map(entry => entry.runId), ['old-open']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('corrupt legacy journal fails closed and an uncommitted import can be retried', async () => {
  const { directory, file } = await fixture();
  try {
    await writeFile(file, '{broken', { mode: 0o600 });
    await assert.rejects(new RunCommitJournal(file).get('owner', 'old'));
    assert.equal(await readFile(file, 'utf8'), '{broken');
    const entry = legacyEntry('old');
    await writeFile(file, JSON.stringify({ version: 1, entries: { [entry.id]: entry } }));
    assert.equal((await new RunCommitJournal(file).get('owner', 'old'))?.phase, 'prepared');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('phase replay is stable and a rolled-back update leaves recovery evidence unchanged', async () => {
  const { directory, file } = await fixture();
  try {
    const journal = new RunCommitJournal(file);
    const input = { sessionId: 'owner', runId: 'run', answerDigest: runAnswerDigest('answer'), runtimeActions: [] };
    await journal.prepare(input);
    const committed = await journal.advance('owner', 'run', 'receipt_committed');
    assert.deepEqual(await journal.advance('owner', 'run', 'receipt_committed'), committed);
    assert.deepEqual(await journal.advance('owner', 'run', 'prepared'), committed);
    await assert.rejects(journal.prepare({ ...input, answerDigest: runAnswerDigest('different') }), /不同的提交计划/);
    assert.deepEqual(await new RunCommitJournal(file).get('owner', 'run'), committed);
    const db = new DatabaseSync(`${file}.sqlite`);
    db.exec("BEGIN IMMEDIATE; UPDATE run_commits SET phase='finalized', entry_json='corrupt'; ROLLBACK");
    db.close();
    assert.deepEqual(await new RunCommitJournal(file).get('owner', 'run'), committed);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an interrupted legacy import rolls back every row and its marker before retry', async () => {
  const { directory, file } = await fixture();
  try {
    await writeFile(file, '{broken');
    await assert.rejects(new RunCommitJournal(file).recoverable()); // schema exists, import not committed
    const entries = [legacyEntry('first'), legacyEntry('second', 'finalized')];
    const source = JSON.stringify({ version: 1, entries: Object.fromEntries(entries.map(entry => [entry.id, entry])) });
    await writeFile(file, source);
    const db = new DatabaseSync(`${file}.sqlite`);
    try {
      db.exec(`CREATE TRIGGER interrupt_import BEFORE INSERT ON run_commits
        WHEN NEW.id='${entries[1]!.id}' BEGIN SELECT RAISE(ABORT, 'simulated import interruption'); END`);
      await assert.rejects(new RunCommitJournal(file).recoverable(), /simulated import interruption/);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM run_commits').get()?.count, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM journal_meta').get()?.count, 0);
      db.exec('DROP TRIGGER interrupt_import');
    } finally { db.close(); }
    assert.equal(await readFile(file, 'utf8'), source);
    assert.equal((await new RunCommitJournal(file).recoverable()).length, 1);
    assert.equal((await new RunCommitJournal(file).get('owner', 'second'))?.phase, 'finalized');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
