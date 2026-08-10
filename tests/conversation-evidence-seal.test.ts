import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  rmdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createEvidenceSeal,
  eraseOffendingEvidenceFile,
  verifyEvidenceSeal,
} from '../scripts/conversation-evidence-seal.js';

const ATTESTATION = 'evidence-integrity.json';

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function privateRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  await chmod(root, 0o700);
  return root;
}

async function privateWrite(file: string, contents: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, contents, { mode: 0o600 });
}

test('detached seal excludes only its attestation and records a complete sorted generation', async () => {
  const root = await privateRoot('mimi-evidence-seal-');
  try {
    await privateWrite(path.join(root, 'pty-smoke-canonical', 'turn-01.event.json'), '{"id":"event-1"}\n');
    await privateWrite(path.join(root, 'evidence.jsonl'), '{"kind":"run_finished"}\n');
    const manifest = await createEvidenceSeal(root, ATTESTATION, { generation: 7 });

    assert.equal(manifest.detached, true);
    assert.equal(manifest.excludedAttestationPath, ATTESTATION);
    assert.equal(manifest.generation, 7);
    assert.equal(manifest.parentIndexHash, null);
    assert.deepEqual(manifest.files.map((entry) => entry.path), [
      'evidence.jsonl',
      'pty-smoke-canonical/turn-01.event.json',
    ]);
    assert.ok(manifest.files.every((entry) => entry.generation === 7));
    assert.deepEqual(manifest.files.map((entry) => entry.role), [
      'protocol-journal',
      'canonical-entity',
    ]);
    assert.equal(manifest.files.some((entry) => entry.path === ATTESTATION), false);
    assert.equal((await lstat(path.join(root, ATTESTATION))).mode & 0o777, 0o600);

    const verified = await verifyEvidenceSeal(root, ATTESTATION, { expectedGeneration: 7 });
    assert.equal(verified.verified, true);
    assert.equal(verified.attestationSha256, sha256(await readFile(path.join(root, ATTESTATION))));
    assert.deepEqual(verified.manifest, manifest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verification rejects added, deleted, modified, and unindexed correction evidence', async (t) => {
  const cases = [
    {
      name: 'added',
      mutate: (root: string) => privateWrite(path.join(root, 'late.json'), '{}\n'),
      pattern: /unexpected evidence file late\.json/iu,
    },
    {
      name: 'deleted',
      mutate: (root: string) => rm(path.join(root, 'proof.json')),
      pattern: /missing evidence file proof\.json/iu,
    },
    {
      name: 'modified',
      mutate: (root: string) => writeFile(path.join(root, 'proof.json'), '{"passed":false}\n', { mode: 0o600 }),
      pattern: /evidence manifest mismatch.*proof\.json/iu,
    },
    {
      name: 'unindexed-correction',
      mutate: (root: string) => privateWrite(path.join(root, 'audit-correction.json'), '{"classification":"unproven"}\n'),
      pattern: /unindexed correction artifact audit-correction\.json/iu,
    },
  ] as const;
  for (const current of cases) {
    await t.test(current.name, async () => {
      const root = await privateRoot(`mimi-evidence-seal-${current.name}-`);
      try {
        await privateWrite(path.join(root, 'proof.json'), '{"passed":true}\n');
        await createEvidenceSeal(root, ATTESTATION, { generation: 0 });
        await current.mutate(root);
        await assert.rejects(verifyEvidenceSeal(root, ATTESTATION), current.pattern);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test('seal creation and verification reject unindexed empty directories', async () => {
  const root = await privateRoot('mimi-evidence-empty-directory-');
  try {
    await privateWrite(path.join(root, 'proof.json'), '{}\n');
    await mkdir(path.join(root, 'empty'), { mode: 0o700 });
    await assert.rejects(
      createEvidenceSeal(root, ATTESTATION, { generation: 0 }),
      /empty unindexed directory.*empty/iu,
    );
    await rmdir(path.join(root, 'empty'));
    await createEvidenceSeal(root, ATTESTATION, { generation: 0 });
    await mkdir(path.join(root, 'late-empty'), { mode: 0o700 });
    await assert.rejects(
      verifyEvidenceSeal(root, ATTESTATION),
      /empty unindexed directory.*late-empty/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('seal traversal rejects public directories/files, hardlinks, symlinks, and a second attestation', async (t) => {
  const cases: Array<{
    name: string;
    prepare(root: string): Promise<void>;
    pattern: RegExp;
  }> = [
    {
      name: 'public-directory',
      prepare: async (root) => {
        await mkdir(path.join(root, 'public'), { mode: 0o755 });
        await privateWrite(path.join(root, 'public', 'value.json'), '{}\n');
      },
      pattern: /directory is not private.*public/iu,
    },
    {
      name: 'public-file',
      prepare: async (root) => {
        const file = path.join(root, 'public.json');
        await privateWrite(file, '{}\n');
        await chmod(file, 0o644);
      },
      pattern: /file is not private.*public\.json/iu,
    },
    {
      name: 'hardlink',
      prepare: async (root) => {
        const original = path.join(root, 'original.json');
        await privateWrite(original, '{}\n');
        await link(original, path.join(root, 'copy.json'));
      },
      pattern: /multiple links/iu,
    },
    {
      name: 'symlink',
      prepare: async (root) => {
        const target = path.join(root, 'target.json');
        await privateWrite(target, '{}\n');
        await symlink(target, path.join(root, 'linked.json'));
      },
      pattern: /unsupported evidence entry linked\.json/iu,
    },
    {
      name: 'second-attestation',
      prepare: async (root) => {
        await privateWrite(path.join(root, 'previous.evidence-seal.json'), '{}\n');
      },
      pattern: /multiple attestation files/iu,
    },
  ];
  for (const current of cases) {
    await t.test(current.name, async () => {
      const root = await privateRoot(`mimi-evidence-seal-${current.name}-`);
      try {
        await current.prepare(root);
        await assert.rejects(
          createEvidenceSeal(root, ATTESTATION, { generation: 0 }),
          current.pattern,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test('canonical indexes bind each referenced artifact hash and corrections must be indexed', async () => {
  const root = await privateRoot('mimi-evidence-canonical-index-');
  try {
    const event = '{"id":"event-1"}\n';
    const correction = '{"classification":"unproven"}\n';
    await privateWrite(path.join(root, 'canonical', 'event.json'), event);
    await privateWrite(path.join(root, 'audit-correction.json'), correction);
    const indexFile = path.join(root, 'run.canonical-index.json');
    await privateWrite(indexFile, `${JSON.stringify({
      schemaVersion: 1,
      artifacts: [
        { path: 'canonical/event.json', sha256: '0'.repeat(64), bytes: Buffer.byteLength(event) },
        {
          path: 'audit-correction.json',
          sha256: sha256(correction),
          bytes: Buffer.byteLength(correction),
        },
      ],
    })}\n`);
    await assert.rejects(
      createEvidenceSeal(root, ATTESTATION, { generation: 0 }),
      /canonical artifact hash mismatch.*canonical\/event\.json/iu,
    );

    await writeFile(indexFile, `${JSON.stringify({
      schemaVersion: 1,
      artifacts: [
        { path: 'canonical/event.json', sha256: sha256(event), bytes: Buffer.byteLength(event) },
        {
          path: 'audit-correction.json',
          sha256: sha256(correction),
          bytes: Buffer.byteLength(correction),
        },
      ],
    })}\n`, { mode: 0o600 });
    await createEvidenceSeal(root, ATTESTATION, { generation: 0 });
    assert.equal((await verifyEvidenceSeal(root, ATTESTATION)).verified, true);

    await writeFile(path.join(root, 'canonical', 'event.json'), '{"id":"event-2"}\n', { mode: 0o600 });
    await assert.rejects(
      verifyEvidenceSeal(root, ATTESTATION),
      /evidence manifest mismatch.*canonical\/event\.json/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a replacement generation is chained to the exact previous attestation hash', async () => {
  const root = await privateRoot('mimi-evidence-generation-');
  try {
    await privateWrite(path.join(root, 'proof.json'), '{}\n');
    await createEvidenceSeal(root, ATTESTATION, { generation: 3 });
    const parentIndexHash = sha256(await readFile(path.join(root, ATTESTATION)));

    await assert.rejects(
      createEvidenceSeal(root, ATTESTATION, { generation: 4, parentIndexHash: 'f'.repeat(64) }),
      /parentIndexHash does not match/iu,
    );
    const next = await createEvidenceSeal(root, ATTESTATION, { generation: 4, parentIndexHash });
    assert.equal(next.parentIndexHash, parentIndexHash);
    assert.ok(next.files.every((entry) => entry.generation === 4));
    assert.equal((await verifyEvidenceSeal(root, ATTESTATION, {
      expectedGeneration: 4,
      expectedParentIndexHash: parentIndexHash,
    })).verified, true);
    await assert.rejects(
      createEvidenceSeal(root, ATTESTATION, {
        generation: 6,
        parentIndexHash: sha256(await readFile(path.join(root, ATTESTATION))),
      }),
      /next seal generation must be 5/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('privacy erasure overwrites one physical file, syncs, unlinks, and writes only a hash tombstone', async () => {
  const root = await privateRoot('mimi-evidence-erasure-');
  const secret = Buffer.from('synthetic-secret-must-not-survive');
  const offending = path.join(root, 'unsafe.bin');
  const tombstone = path.join(root, 'privacy-tombstone.json');
  try {
    await privateWrite(offending, secret);
    const phases: string[] = [];
    const record = await eraseOffendingEvidenceFile(root, 'unsafe.bin', 'privacy-tombstone.json', {
      generation: 9,
      reason: 'privacy-match',
      onPhase: async (phase) => {
        phases.push(phase);
        if (phase === 'overwritten-synced') {
          assert.deepEqual(await readFile(offending), Buffer.alloc(secret.byteLength));
        }
      },
    });
    assert.deepEqual(phases, [
      'overwritten-synced',
      'unlinked',
      'directory-synced',
      'tombstone-written',
    ]);
    await assert.rejects(lstat(offending), (error: unknown) => (
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ));
    assert.equal((await lstat(tombstone)).mode & 0o777, 0o600);
    const bytes = await readFile(tombstone);
    assert.equal(bytes.includes(secret), false);
    assert.deepEqual(JSON.parse(bytes.toString('utf8')), record);
    assert.equal(record.removedFileSha256, sha256(secret));
    assert.equal(record.removedBytes, secret.byteLength);
    assert.match(record.removedPathSha256, /^[0-9a-f]{64}$/u);
    assert.equal(JSON.stringify(record).includes('unsafe.bin'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('privacy erasure fails before touching a file when the tombstone exists or the source is linked', async () => {
  const root = await privateRoot('mimi-evidence-erasure-preflight-');
  try {
    const source = path.join(root, 'unsafe.bin');
    await privateWrite(source, 'sensitive-bytes');
    await privateWrite(path.join(root, 'privacy-tombstone.json'), '{}\n');
    await assert.rejects(
      eraseOffendingEvidenceFile(root, 'unsafe.bin', 'privacy-tombstone.json', {
        generation: 1,
        reason: 'privacy-match',
      }),
      /tombstone destination already exists/iu,
    );
    assert.equal(await readFile(source, 'utf8'), 'sensitive-bytes');

    await rm(path.join(root, 'privacy-tombstone.json'));
    await link(source, path.join(root, 'unsafe-copy.bin'));
    await assert.rejects(
      eraseOffendingEvidenceFile(root, 'unsafe.bin', 'privacy-tombstone.json', {
        generation: 1,
        reason: 'privacy-match',
      }),
      /multiple links/iu,
    );
    assert.equal(await readFile(source, 'utf8'), 'sensitive-bytes');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
