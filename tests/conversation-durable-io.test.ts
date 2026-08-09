import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
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
  DurableJournalWriter,
  MonotonicCheckpointWriter,
  recoverEphemeralCredentialFiles,
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

test('journal writer serializes concurrent appends and remains poisoned after its first durability fault', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-conversation-journal-writer-'));
  try {
    const journal = path.join(root, 'evidence.jsonl');
    const writer = new DurableJournalWriter(journal);
    const phases: string[] = [];
    let unblockFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { unblockFirst = resolve; });
    let firstReachedWrite!: () => void;
    const firstWritten = new Promise<void>((resolve) => { firstReachedWrite = resolve; });

    const first = writer.append('first\n', {
      onPhase: async (current) => {
        phases.push(`first:${current}`);
        if (current === 'append-written') {
          firstReachedWrite();
          await firstBlocked;
        }
        if (current === 'append-synced') throw new Error('synthetic-journal-fsync-fault');
      },
    });
    const firstFailure = assert.rejects(first, /synthetic-journal-fsync-fault/u);
    await firstWritten;

    const second = writer.append('second\n', {
      onPhase: (current) => { phases.push(`second:${current}`); },
    });
    const secondFailure = assert.rejects(second, /synthetic-journal-fsync-fault/u);
    let providerCalls = 0;
    const dispatch = writer.dispatchBarrier(() => {
      providerCalls += 1;
    });
    const dispatchFailure = assert.rejects(dispatch, /synthetic-journal-fsync-fault/u);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(phases, ['first:append-written']);

    unblockFirst();
    await Promise.all([firstFailure, secondFailure, dispatchFailure]);
    assert.equal(providerCalls, 0);
    assert.deepEqual(phases, ['first:append-written', 'first:append-synced']);
    assert.equal(await readFile(journal, 'utf8'), 'first\n');

    await assert.rejects(writer.append('third\n'), /synthetic-journal-fsync-fault/u);
    await assert.rejects(writer.dispatchBarrier(() => {
      providerCalls += 1;
    }), /synthetic-journal-fsync-fault/u);
    assert.equal(providerCalls, 0);
    assert.equal(await readFile(journal, 'utf8'), 'first\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('monotonic checkpoint writer rejects an old generation that completes after a newer snapshot', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-conversation-checkpoint-writer-'));
  try {
    const checkpoint = path.join(root, 'checkpoint.json');
    const writer = new MonotonicCheckpointWriter(checkpoint);
    await writer.write({ generation: 1, sequence: 0 }, 'initial\n');

    let unblockOld!: () => void;
    const oldBlocked = new Promise<void>((resolve) => { unblockOld = resolve; });
    let oldReachedTemporarySync!: () => void;
    const oldTemporarySynced = new Promise<void>((resolve) => {
      oldReachedTemporarySync = resolve;
    });
    const oldWrite = writer.write({ generation: 1, sequence: 1 }, 'old-late\n', {
      onPhase: async (current) => {
        if (current !== 'temporary-synced') return;
        oldReachedTemporarySync();
        await oldBlocked;
      },
    });
    const oldFailure = assert.rejects(oldWrite, /stale checkpoint version/iu);
    await oldTemporarySynced;

    await writer.write({ generation: 1, sequence: 2 }, 'newer\n');
    assert.equal(await readFile(checkpoint, 'utf8'), 'newer\n');
    unblockOld();
    await oldFailure;
    assert.equal(await readFile(checkpoint, 'utf8'), 'newer\n');

    await assert.rejects(
      writer.write({ generation: 1, sequence: 2 }, 'duplicate\n'),
      /stale checkpoint version/iu,
    );
    await assert.rejects(
      writer.write({ generation: 0, sequence: 999 }, 'old-generation\n'),
      /stale checkpoint version/iu,
    );
    assert.equal(await readFile(checkpoint, 'utf8'), 'newer\n');
    assert.deepEqual((await readdir(root)).filter((name) => name.includes('.tmp-')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('startup recovery overwrites and removes a Provider credential abandoned by SIGKILL', async () => {
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
    assert.equal(await mode(path.join(credential.root, '.owner')), 0o600);
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
    const recovery = await recoverEphemeralCredentialFiles({
      temporaryRoot: privateTemporaryRoot,
    });
    assert.deepEqual(recovery, { scanned: 1, recovered: 1, preserved: 0 });
    await assert.rejects(lstat(credential.root), /ENOENT/u);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});

test('normal Provider credential cleanup overwrites the secret and durably removes its owner root', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'mimi-conversation-secret-cleanup-'));
  const credential = await createEphemeralCredentialFile('ONLY_KEY=normal-cleanup-secret\n', {
    temporaryRoot,
  });
  try {
    const cleanupPhases: string[] = [];
    await cleanupEphemeralCredentialFile(credential, {
      onPhase: async (phase) => {
        cleanupPhases.push(phase);
        if (phase === 'credential-overwritten') {
          assert.ok((await readFile(credential.file)).every((byte) => byte === 0));
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
    await cleanupEphemeralCredentialFile(credential).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('credential recovery preserves the live owner and reclaims a reused PID identity', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'mimi-conversation-secret-owner-'));
  const credential = await createEphemeralCredentialFile('ONLY_KEY=owner-identity-secret\n', {
    temporaryRoot,
  });
  try {
    assert.deepEqual(
      await recoverEphemeralCredentialFiles({ temporaryRoot, graceMs: 0 }),
      { scanned: 1, recovered: 0, preserved: 1 },
    );
    assert.equal(await readFile(credential.file, 'utf8'), 'ONLY_KEY=owner-identity-secret\n');

    const ownerFile = path.join(credential.root, '.owner');
    const owner = JSON.parse(await readFile(ownerFile, 'utf8')) as {
      processStartIdentity: string;
    };
    owner.processStartIdentity = `${owner.processStartIdentity}:pid-reused`;
    await writeFile(ownerFile, `${JSON.stringify(owner)}\n`, { mode: 0o600 });

    assert.deepEqual(
      await recoverEphemeralCredentialFiles({ temporaryRoot }),
      { scanned: 1, recovered: 1, preserved: 0 },
    );
    await assert.rejects(lstat(credential.root), /ENOENT/u);
  } finally {
    await cleanupEphemeralCredentialFile(credential).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('credential recovery gives malformed owners grace and never follows a credential symlink', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'mimi-conversation-secret-guard-'));
  const malformedRoot = path.join(temporaryRoot, 'mimi-conversation-secret-ABC123');
  const externalFile = path.join(temporaryRoot, 'external.env');
  await mkdir(malformedRoot, { mode: 0o700 });
  await Promise.all([
    writeFile(path.join(malformedRoot, '.owner'), '{malformed', { mode: 0o600 }),
    writeFile(path.join(malformedRoot, '.env'), 'MALFORMED_OWNER_SECRET=1\n', { mode: 0o600 }),
    writeFile(externalFile, 'EXTERNAL_SENTINEL=untouched\n', { mode: 0o600 }),
  ]);
  const symlinkCredential = await createEphemeralCredentialFile('ONLY_KEY=replace-me\n', {
    temporaryRoot,
  });
  try {
    const ownerFile = path.join(symlinkCredential.root, '.owner');
    const owner = JSON.parse(await readFile(ownerFile, 'utf8')) as {
      processStartIdentity: string;
    };
    owner.processStartIdentity = `${owner.processStartIdentity}:pid-reused`;
    await writeFile(ownerFile, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    await unlink(symlinkCredential.file);
    await symlink(externalFile, symlinkCredential.file);

    const recovery = await recoverEphemeralCredentialFiles({
      temporaryRoot,
      graceMs: 60 * 60 * 1_000,
    });
    assert.deepEqual(recovery, { scanned: 2, recovered: 0, preserved: 2 });
    assert.equal(await readFile(path.join(malformedRoot, '.env'), 'utf8'), 'MALFORMED_OWNER_SECRET=1\n');
    assert.equal(await readFile(externalFile, 'utf8'), 'EXTERNAL_SENTINEL=untouched\n');
    assert.equal((await lstat(symlinkCredential.file)).isSymbolicLink(), true);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('credential recovery never overwrites a hard-linked external file', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'mimi-conversation-secret-hardlink-'));
  const externalFile = path.join(temporaryRoot, 'external.env');
  await writeFile(externalFile, 'EXTERNAL_HARDLINK_SENTINEL=untouched\n', { mode: 0o600 });
  const credential = await createEphemeralCredentialFile('ONLY_KEY=replace-me\n', {
    temporaryRoot,
  });
  try {
    const ownerFile = path.join(credential.root, '.owner');
    const owner = JSON.parse(await readFile(ownerFile, 'utf8')) as {
      processStartIdentity: string;
    };
    owner.processStartIdentity = `${owner.processStartIdentity}:pid-reused`;
    await writeFile(ownerFile, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    await unlink(credential.file);
    await link(externalFile, credential.file);

    assert.deepEqual(
      await recoverEphemeralCredentialFiles({ temporaryRoot, graceMs: 0 }),
      { scanned: 1, recovered: 0, preserved: 1 },
    );
    assert.equal(await readFile(externalFile, 'utf8'), 'EXTERNAL_HARDLINK_SENTINEL=untouched\n');
    assert.equal((await stat(externalFile)).nlink, 2);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
