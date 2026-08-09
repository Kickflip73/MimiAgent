import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  cleanupEphemeralCredentialFile,
  createEphemeralCredentialFile,
  durableAppend,
  durableReplace,
  durableWriteExclusive,
} from '../scripts/conversation-durable-io.js';

const repositoryRoot = path.resolve(import.meta.dirname, '..');

async function mode(file: string): Promise<number> {
  return (await stat(file)).mode & 0o777;
}

async function filesBelow(root: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) await visit(absolute);
      else output.push(relative);
    }
  };
  await visit(root);
  return output.sort();
}

async function childLine(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('credential child did not become ready')), 10_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const newline = output.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      resolve(output.slice(0, newline));
    });
  });
}

test('durable file protocols sync before publish, preserve no-clobber, and keep old checkpoints on pre-publish failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-conversation-durable-'));
  try {
    const evidence = path.join(root, 'turn.json');
    const phases: string[] = [];
    await durableWriteExclusive(evidence, 'first\n', {
      onPhase: (phase) => { phases.push(phase); },
    });
    assert.deepEqual(phases, ['temporary-synced', 'published', 'directory-synced']);
    assert.equal(await readFile(evidence, 'utf8'), 'first\n');
    assert.equal(await mode(evidence), 0o600);
    await assert.rejects(durableWriteExclusive(evidence, 'second\n'), /already exists/iu);
    assert.equal(await readFile(evidence, 'utf8'), 'first\n');

    const checkpoint = path.join(root, 'checkpoint.json');
    await durableReplace(checkpoint, 'old\n');
    await assert.rejects(durableReplace(checkpoint, 'new\n', {
      onPhase: (phase) => {
        if (phase === 'temporary-synced') throw new Error('fault-before-publish');
      },
    }), /fault-before-publish/u);
    assert.equal(await readFile(checkpoint, 'utf8'), 'old\n');
    assert.deepEqual((await readdir(root)).filter((name) => name.includes('.tmp-')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('durable append completes file and directory sync before dispatch and a failed barrier cannot call the Provider boundary', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-conversation-journal-'));
  try {
    const journal = path.join(root, 'evidence.jsonl');
    const order: string[] = [];
    await durableAppend(journal, '{"kind":"turn_dispatch_started"}\n', {
      onPhase: (phase) => { order.push(phase); },
    });
    order.push('provider-dispatch');
    assert.deepEqual(order, [
      'append-written',
      'append-synced',
      'directory-synced',
      'provider-dispatch',
    ]);
    assert.equal(await mode(journal), 0o600);

    const faultJournal = path.join(root, 'fault.jsonl');
    let providerCalls = 0;
    await assert.rejects((async () => {
      await durableAppend(faultJournal, '{"kind":"turn_dispatch_started","turn":2}\n', {
        onPhase: (phase) => {
          if (phase === 'append-synced') throw new Error('fault-before-directory-sync');
        },
      });
      providerCalls += 1;
    })(), /fault-before-directory-sync/u);
    assert.equal(providerCalls, 0);
    assert.match(await readFile(faultJournal, 'utf8'), /"turn":2/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Provider credential files live outside retained evidence and a SIGKILL cannot copy the secret into the bundle', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-conversation-secret-evidence-'));
  const evidenceRoot = path.join(root, 'evidence');
  const privateTemporaryRoot = path.join(root, 'private-tmp');
  const secret = 'synthetic-provider-secret-for-crash-proof';
  await chmod(root, 0o700);
  await Promise.all([
    mkdir(evidenceRoot, { mode: 0o700 }),
    mkdir(privateTemporaryRoot, { mode: 0o700 }),
  ]);
  const helperUrl = pathToFileURL(path.join(repositoryRoot, 'scripts', 'conversation-durable-io.ts')).href;
  const child = spawn(process.execPath, [
    '--import', 'tsx',
    '--input-type=module',
    '--eval', [
      `import { createEphemeralCredentialFile, durableWriteExclusive } from ${JSON.stringify(helperUrl)};`,
      `const evidenceRoot = ${JSON.stringify(evidenceRoot)};`,
      `const temporaryRoot = ${JSON.stringify(privateTemporaryRoot)};`,
      `const secret = ${JSON.stringify(secret)};`,
      'const credential = await createEphemeralCredentialFile(`ONLY_KEY=${secret}\\n`, { temporaryRoot, excludedRoot: evidenceRoot });',
      `await durableWriteExclusive(${JSON.stringify(path.join(evidenceRoot, 'bundle.json'))}, JSON.stringify({ providerSecretNames: ["ONLY_KEY"] }));`,
      'process.stdout.write(`${JSON.stringify(credential)}\\n`);',
      'setInterval(() => undefined, 1000);',
    ].join('\n'),
  ], {
    cwd: repositoryRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let credential: { root: string; file: string } | undefined;
  try {
    credential = JSON.parse(await childLine(child)) as { root: string; file: string };
    assert.equal(path.resolve(credential.root).startsWith(`${path.resolve(evidenceRoot)}${path.sep}`), false);
    assert.equal(await mode(credential.root), 0o700);
    assert.equal(await mode(credential.file), 0o600);
    assert.equal(await readFile(credential.file, 'utf8'), `ONLY_KEY=${secret}\n`);

    child.kill('SIGKILL');
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
    const retainedFiles = await filesBelow(evidenceRoot);
    assert.deepEqual(retainedFiles, ['bundle.json']);
    for (const file of retainedFiles) {
      assert.doesNotMatch(await readFile(path.join(evidenceRoot, file), 'utf8'), new RegExp(secret, 'u'));
    }

    const cleanupPhases: string[] = [];
    await cleanupEphemeralCredentialFile(credential, {
      onPhase: async (phase) => {
        cleanupPhases.push(phase);
        if (phase === 'credential-overwritten') {
          assert.ok((await readFile(credential!.file)).every((byte) => byte === 0));
        }
      },
    });
    assert.deepEqual(cleanupPhases, [
      'credential-overwritten',
      'credential-unlinked',
      'secret-root-removed',
    ]);
    await assert.rejects(lstat(credential.root), /ENOENT/u);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (credential) await cleanupEphemeralCredentialFile(credential).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
