import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  conversationEvidenceAttestationFile,
  conversationEvidenceOutcomeFile,
  finalizeConversationEvidence,
  initializeConversationEvidenceRoot,
} from '../scripts/conversation-evidence-finalization.js';
import { verifyEvidenceSeal } from '../scripts/conversation-evidence-seal.js';

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-evidence-finalize-'));
  await chmod(root, 0o700);
  return root;
}

async function privateWrite(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, contents, { mode: 0o600 });
}

test('successful evidence finalization writes an independently verifiable detached seal', async () => {
  const root = await privateRoot();
  try {
    const rootHandle = await initializeConversationEvidenceRoot(root);
    const proof = '{"kind":"persistent-pty-prerequisite","passed":true}\n';
    await privateWrite(path.join(root, 'pty-smoke.proof.json'), proof);
    const finalized = await finalizeConversationEvidence({
      root: rootHandle,
      privateEvidenceNeedles: [{ kind: 'provider-secret', value: 'synthetic-private-value' }],
      manifestDigest: 'a'.repeat(64),
      buildDigest: 'b'.repeat(64),
      proofEligible: true,
      now: () => new Date('2026-08-10T00:00:00.000Z'),
    });

    assert.equal(finalized.outcome.proofEligible, true);
    assert.deepEqual(finalized.outcome.privacyFailures, []);
    assert.deepEqual(finalized.outcome.checkedNeedleKinds, ['provider-secret']);
    assert.equal(finalized.seal.excludedAttestationPath, conversationEvidenceAttestationFile);
    assert.ok(finalized.seal.files.some((entry) => (
      entry.path === 'pty-smoke.proof.json' && entry.sha256 === sha256(proof)
    )));
    assert.ok(finalized.seal.files.some((entry) => entry.path === conversationEvidenceOutcomeFile));
    assert.equal((await verifyEvidenceSeal(root, conversationEvidenceAttestationFile)).verified, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('privacy failure is erased before sealing and stale proof/index artifacts are revoked', async () => {
  const root = await privateRoot();
  const secret = 'nonstandard-private-provider-value';
  try {
    const rootHandle = await initializeConversationEvidenceRoot(root);
    await privateWrite(path.join(root, 'unsafe.log'), `prefix ${secret} suffix\n`);
    await privateWrite(path.join(root, 'pty-smoke.proof.json'), '{"passed":true}\n');
    await privateWrite(path.join(root, 'pty-smoke.canonical-index.json'), '{"artifacts":[]}\n');
    const finalized = await finalizeConversationEvidence({
      root: rootHandle,
      privateEvidenceNeedles: [{ kind: 'provider-secret', value: secret }],
      manifestDigest: 'c'.repeat(64),
      buildDigest: 'd'.repeat(64),
      proofEligible: true,
    });

    assert.equal(finalized.outcome.proofEligible, false);
    assert.equal(finalized.outcome.privacyFailures.length, 1);
    assert.equal(finalized.outcome.privacyFailures[0]?.kind, 'provider-secret');
    assert.match(finalized.outcome.privacyFailures[0]?.pathHash ?? '', /^[0-9a-f]{64}$/u);
    await assert.rejects(lstat(path.join(root, 'unsafe.log')), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(root, 'pty-smoke.proof.json')), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(root, 'pty-smoke.canonical-index.json')), { code: 'ENOENT' });
    const tombstones = await readdir(path.join(root, 'privacy-tombstones'), { withFileTypes: true });
    assert.equal(tombstones.length, 3);
    const serialized = Buffer.concat(await Promise.all(tombstones.map(async (entry) => (
      readFile(path.join(root, 'privacy-tombstones', entry.name))
    ))));
    assert.equal(serialized.includes(Buffer.from(secret)), false);
    assert.equal((await verifyEvidenceSeal(root, conversationEvidenceAttestationFile)).verified, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a private path component removes its complete subtree without preserving the path', async () => {
  const root = await privateRoot();
  const privateComponent = 'private-home-fragment';
  try {
    const rootHandle = await initializeConversationEvidenceRoot(root);
    await privateWrite(path.join(root, privateComponent, 'nested', 'value.json'), '{"ok":true}\n');
    const finalized = await finalizeConversationEvidence({
      root: rootHandle,
      privateEvidenceNeedles: [{ kind: 'private-home', value: privateComponent }],
      manifestDigest: 'e'.repeat(64),
      buildDigest: 'f'.repeat(64),
      proofEligible: true,
    });
    assert.equal(finalized.outcome.proofEligible, false);
    await assert.rejects(lstat(path.join(root, privateComponent)), { code: 'ENOENT' });
    const bytes = await readFile(path.join(root, conversationEvidenceAttestationFile));
    assert.equal(bytes.includes(Buffer.from(privateComponent)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid parameters and an unowned root fail before destructive privacy cleanup', async () => {
  const root = await privateRoot();
  const unsafe = path.join(root, 'unsafe.log');
  try {
    await privateWrite(unsafe, 'private-value\n');
    const handle = await initializeConversationEvidenceRoot(root);
    await assert.rejects(
      finalizeConversationEvidence({
        root: handle,
        privateEvidenceNeedles: [{ kind: 'provider-secret', value: 'private-value' }],
        manifestDigest: 'not-a-digest',
        buildDigest: 'b'.repeat(64),
        proofEligible: true,
      }),
      /manifestDigest/iu,
    );
    assert.equal(await readFile(unsafe, 'utf8'), 'private-value\n');
    await assert.rejects(
      finalizeConversationEvidence({
        root: handle,
        privateEvidenceNeedles: [{ kind: 'provider-secret', value: 'private-value' }],
        manifestDigest: 'a'.repeat(64),
        buildDigest: 'b'.repeat(64),
        proofEligible: true,
        generation: 1,
      }),
      /generation 0/iu,
    );
    assert.equal(await readFile(unsafe, 'utf8'), 'private-value\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const bare = await privateRoot();
  try {
    await privateWrite(path.join(bare, 'unsafe.log'), 'private-value\n');
    await assert.rejects(
      finalizeConversationEvidence({
        root: { root: bare, token: '0'.repeat(36), device: '0', inode: '0' },
        privateEvidenceNeedles: [{ kind: 'provider-secret', value: 'private-value' }],
        manifestDigest: 'a'.repeat(64),
        buildDigest: 'b'.repeat(64),
        proofEligible: true,
      }),
      /marker|identity/iu,
    );
    assert.equal(await readFile(path.join(bare, 'unsafe.log'), 'utf8'), 'private-value\n');
  } finally {
    await rm(bare, { recursive: true, force: true });
  }
});

test('finalizer-owned serialized literals are rejected before any evidence mutation', async () => {
  const collidingValues = [
    'provider-secret',
    'private-home',
    'credential-root',
    'credential-file',
    'runtime-root',
    'conversation-evidence-outcome',
    'schemaVersion',
  ];
  for (const value of collidingValues) {
    const root = await privateRoot();
    try {
      const handle = await initializeConversationEvidenceRoot(root);
      const unsafe = path.join(root, 'unsafe.log');
      const original = `user evidence still contains exact ${value}\n`;
      await privateWrite(unsafe, original);
      const before = (await readdir(root)).sort();

      await assert.rejects(
        finalizeConversationEvidence({
          root: handle,
          privateEvidenceNeedles: [{ kind: 'provider-secret', value }],
          manifestDigest: 'a'.repeat(64),
          buildDigest: 'b'.repeat(64),
          proofEligible: true,
        }),
        /finalizer-owned serialized metadata/iu,
      );

      assert.deepEqual((await readdir(root)).sort(), before);
      assert.equal(await readFile(unsafe, 'utf8'), original);
      await assert.rejects(lstat(path.join(root, 'evidence-outcome.json')), { code: 'ENOENT' });
      await assert.rejects(lstat(path.join(root, 'evidence-revocation.json')), { code: 'ENOENT' });
      await assert.rejects(lstat(path.join(root, 'evidence-integrity.json')), { code: 'ENOENT' });
      await assert.rejects(lstat(path.join(root, 'privacy-tombstones')), { code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('the first privacy hit durably revokes proof before any later erasure failure', async () => {
  const root = await privateRoot();
  const outside = await privateRoot();
  try {
    const handle = await initializeConversationEvidenceRoot(root);
    const proof = path.join(root, 'z-stale.proof.json');
    await privateWrite(proof, '{"passed":true}\n');
    await link(proof, path.join(outside, 'proof-copy.json'));
    await privateWrite(path.join(root, 'unsafe.log'), 'private-value\n');
    await assert.rejects(
      finalizeConversationEvidence({
        root: handle,
        privateEvidenceNeedles: [{ kind: 'provider-secret', value: 'private-value' }],
        manifestDigest: 'a'.repeat(64),
        buildDigest: 'b'.repeat(64),
        proofEligible: true,
      }),
      /multiple links/iu,
    );
    const revocation = JSON.parse(await readFile(path.join(root, 'evidence-revocation.json'), 'utf8')) as {
      proofEligible?: unknown;
      pathHash?: unknown;
    };
    assert.equal(revocation.proofEligible, false);
    assert.match(String(revocation.pathHash), /^[0-9a-f]{64}$/u);
    await assert.rejects(lstat(path.join(root, 'evidence-integrity.json')), { code: 'ENOENT' });
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});
