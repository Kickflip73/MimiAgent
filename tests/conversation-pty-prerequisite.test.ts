import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  finalizeConversationEvidence,
  initializeConversationEvidenceRoot,
} from '../scripts/conversation-evidence-finalization.js';
import { createEvidenceSeal } from '../scripts/conversation-evidence-seal.js';
import { verifyConversationPtyPrerequisite } from '../scripts/conversation-pty-prerequisite.js';

const manifestDigest = 'a'.repeat(64);
const buildDigest = 'b'.repeat(64);
const completeNeedles = [
  { kind: 'provider-secret' as const, value: 'private-value-not-present' },
  { kind: 'private-home' as const, value: '/synthetic/private/home-not-present' },
  { kind: 'credential-root' as const, value: '/synthetic/credential-root-not-present' },
  { kind: 'credential-file' as const, value: '/synthetic/credential-root-not-present/.env' },
  { kind: 'runtime-root' as const, value: '/synthetic/runtime-root-not-present' },
];

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), 'mimi-pty-prerequisite-'));
  await chmod(value, 0o700);
  return value;
}

function proof(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    kind: 'persistent-pty-prerequisite',
    passed: true,
    tty: true,
    manifestDigest,
    buildDigest,
    retainedEvidenceIntegrityRequired: true,
    startupObserved: true,
    helperTranscriptProven: true,
    privatePathTransformProven: true,
    connectorIsolationProven: true,
    transportChunksObserved: true,
    assistantOutputVisibleAfterInputEcho: true,
    canonicalChainProven: true,
    toolSurfaceProven: true,
    usageProven: true,
    noncesInSession: true,
    noncesInTerminal: true,
    secretHits: 0,
    exitCode: 0,
    turns: 2,
    sourceTreeChanged: false,
    runtimeClosureChanged: false,
    rawRuntimeDeleted: true,
    rawRuntimeRetainedExternally: false,
    rawRuntimeQuarantinedExternally: false,
    rawRuntimeFinalizationProven: true,
    forcedShardKill: false,
    ...overrides,
  })}\n`;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function artifact(directory: string, relative: string, contents: string): Promise<{
  kind: 'test-evidence';
  path: string;
  sha256: string;
  bytes: number;
}> {
  const file = path.join(directory, relative);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, contents, { mode: 0o600 });
  return {
    kind: 'test-evidence',
    path: relative,
    sha256: sha256(contents),
    bytes: Buffer.byteLength(contents),
  };
}

interface SealedProofFixtureOptions {
  corruptConnectorReceiptTurn?: number;
  duplicateFirstTurn?: boolean;
  helperTranscriptSha256?: string;
  overlapActionTurn?: number;
  zeroUsageTurn?: number;
}

async function sealedProof(
  directory: string,
  overrides: Record<string, unknown> = {},
  fixture: SealedProofFixtureOptions = {},
): Promise<string> {
  const rootHandle = await initializeConversationEvidenceRoot(directory);
  const sessionId = 'session-1';
  const turns = [1, 2].map((turn) => ({
    turn,
    nonce: `nonce-${turn}`,
    prompt: `SCENE=conv-001 TURN=${turn} NONCE=nonce-${turn}`,
    answer: `completed nonce-${turn}`,
    eventId: `event-${turn}`,
    taskId: `task-${turn}`,
    daemonRunId: `daemon-run-${turn}`,
    runtimeRunId: `runtime-run-${turn}`,
  }));
  const sessionContents = `${JSON.stringify({
    items: turns.flatMap((turn) => [
      { type: 'message', role: 'user', content: turn.prompt },
      { type: 'message', role: 'assistant', content: turn.answer },
    ]),
  })}\n`;
  const emptyToolDigest = `sha256:${sha256('[]')}`;
  const traceContents = `${turns.flatMap((turn) => [
    { type: 'turn_start', sessionId, data: { input: turn.prompt } },
    {
      type: 'model_binding_event', sessionId,
      data: { workUnitKind: 'conversation', workUnitId: turn.runtimeRunId },
    },
    {
      type: 'model_tool_surface', sessionId,
      data: {
        phase: 'before_model_dispatch', runId: turn.runtimeRunId, advertisedTools: [],
        advertisedToolCount: 0, toolSetDigest: emptyToolDigest,
      },
    },
    {
      type: 'run_finalization', sessionId,
      data: { runId: turn.runtimeRunId, outcome: 'completed' },
    },
    { type: 'turn_end', sessionId, data: { answer: turn.answer } },
  ]).map((entry) => JSON.stringify(entry)).join('\n')}\n`;
  let rawTerminal = '';
  const helperActions = turns.map((turn, index) => {
    const startRawOffset = Buffer.byteLength(rawTerminal);
    rawTerminal += `${turn.prompt}\n${turn.answer}\n`;
    return {
      index: index + 1,
      kind: 'model_turn',
      startRawOffset: fixture.overlapActionTurn === turn.turn ? 0 : startRawOffset,
      endRawOffset: Buffer.byteLength(rawTerminal),
      connectorIsolation: {
        proven: true,
        connectorCount: 0,
        configSha256: fixture.corruptConnectorReceiptTurn === turn.turn
          ? 'f'.repeat(64)
          : sha256('{"connectors":{}}\n'),
      },
      modelRun: {
        daemonRunId: turn.daemonRunId,
        taskId: turn.taskId,
        status: 'completed',
        inputTokens: 10,
        outputTokens: 5,
        promptReadyAfterBusy: true,
        transportChunksObserved: true,
        provenTerminal: true,
      },
    };
  });
  const helperContents = `${JSON.stringify({
    passed: true,
    tty: true,
    childTtyChecked: true,
    startupObserved: true,
    exitCode: 0,
    secretHits: 0,
    transcriptBytes: Buffer.byteLength(rawTerminal),
    transcriptSha256: fixture.helperTranscriptSha256 ?? sha256(rawTerminal),
    retainedTranscriptTransform: {
      schemaVersion: 1,
      algorithm: 'equal-byte-private-needle-v1',
      replacements: 0,
      needleKinds: [],
    },
    actions: helperActions,
  })}\n`;
  const sessionArtifact = await artifact(directory, 'canonical/session.json', sessionContents);
  const traceArtifact = await artifact(directory, 'canonical/trace.jsonl', traceContents);
  const helperArtifact = await artifact(directory, 'pty-smoke.helper.json', helperContents);
  const rawTerminalArtifact = await artifact(directory, 'pty-smoke.terminal.ansi', rawTerminal);
  const normalizedTerminalArtifact = await artifact(directory, 'pty-smoke.terminal.txt', rawTerminal);
  const indexedTurns = [];
  for (const turn of turns) {
    const event = await artifact(directory, `canonical/turn-${turn.turn}.event.json`, `${JSON.stringify({
      id: turn.eventId,
      source: 'local-cli',
      trust: 'owner',
      profileId: 'owner',
      sessionKey: sessionId,
      payload: { prompt: turn.prompt },
    })}\n`);
    const task = await artifact(directory, `canonical/turn-${turn.turn}.task.json`, `${JSON.stringify({
      id: turn.taskId,
      taskId: turn.taskId,
      triggerEventId: turn.eventId,
      authorityEventId: turn.eventId,
      sessionId,
      sessionKey: sessionId,
      profileId: 'owner',
      status: 'completed',
    })}\n`);
    const run = await artifact(directory, `canonical/turn-${turn.turn}.run.json`, `${JSON.stringify({
      id: turn.daemonRunId,
      taskId: turn.taskId,
      sessionKey: sessionId,
      status: 'completed',
      answer: {
        answer: turn.answer,
        usage: {
          runInputTokens: fixture.zeroUsageTurn === turn.turn ? 0 : 10,
          runOutputTokens: 5,
        },
        finalization: { runId: turn.runtimeRunId, outcome: 'completed' },
      },
    })}\n`);
    indexedTurns.push({
      ...turn,
      chainProof: { proven: true, runtimeRunId: turn.runtimeRunId, reasons: [] },
      artifacts: { event, task, run },
    });
  }
  if (fixture.duplicateFirstTurn) {
    const first = indexedTurns[0];
    if (!first) throw new Error('test fixture has no first PTY turn');
    indexedTurns[1] = { ...first, turn: 2 };
  }
  const indexContents = `${JSON.stringify({
    schemaVersion: 1,
    kind: 'persistent-pty-canonical-evidence-index',
    sessionId,
    artifacts: {
      session: sessionArtifact,
      trace: traceArtifact,
      helper: helperArtifact,
      rawTerminal: rawTerminalArtifact,
      normalizedTerminal: normalizedTerminalArtifact,
    },
    turns: indexedTurns,
  })}\n`;
  const indexArtifact = await artifact(directory, 'pty-smoke.canonical-index.json', indexContents);
  const file = path.join(directory, 'pty-smoke.proof.json');
  await writeFile(file, proof({ canonicalEvidenceIndex: indexArtifact, ...overrides }), { mode: 0o600 });
  await finalizeConversationEvidence({
    root: rootHandle,
    privateEvidenceNeedles: completeNeedles,
    manifestDigest,
    buildDigest,
    proofEligible: true,
  });
  return file;
}

test('a generation-zero sealed PTY proof is accepted only for its exact manifest and build', async () => {
  const directory = await root();
  try {
    const proofFile = await sealedProof(directory);
    await verifyConversationPtyPrerequisite({ proofFile, manifestDigest, buildDigest });
    await assert.rejects(
      verifyConversationPtyPrerequisite({ proofFile, manifestDigest: 'c'.repeat(64), buildDigest }),
      /different manifest\/build/iu,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('tampered proof bytes and appended evidence fail complete-tree verification', async () => {
  const cases = ['proof', 'extra'] as const;
  for (const current of cases) {
    const directory = await root();
    try {
      const proofFile = await sealedProof(directory);
      if (current === 'proof') await writeFile(proofFile, proof({ passed: false }), { mode: 0o600 });
      else await writeFile(path.join(directory, 'late.json'), '{}\n', { mode: 0o600 });
      await assert.rejects(
        verifyConversationPtyPrerequisite({ proofFile, manifestDigest, buildDigest }),
        /evidence manifest mismatch|unexpected evidence file/iu,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('privacy failure revokes the proof and cannot become a prerequisite', async () => {
  const directory = await root();
  try {
    const proofFile = path.join(directory, 'pty-smoke.proof.json');
    const secret = 'private-value-in-proof';
    const rootHandle = await initializeConversationEvidenceRoot(directory);
    await writeFile(proofFile, proof({ note: secret }), { mode: 0o600 });
    const finalized = await finalizeConversationEvidence({
      root: rootHandle,
      privateEvidenceNeedles: completeNeedles.map((needle) => (
        needle.kind === 'provider-secret' ? { ...needle, value: secret } : needle
      )),
      manifestDigest,
      buildDigest,
      proofEligible: true,
    });
    assert.equal(finalized.outcome.proofEligible, false);
    await assert.rejects(
      verifyConversationPtyPrerequisite({ proofFile, manifestDigest, buildDigest }),
      /ENOENT/iu,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a later corrected generation cannot retroactively qualify a PTY proof', async () => {
  const directory = await root();
  try {
    const proofFile = await sealedProof(directory);
    const parent = await readFile(path.join(directory, 'evidence-integrity.json'));
    await createEvidenceSeal(directory, 'evidence-integrity.json', {
      generation: 1,
      parentIndexHash: sha256(parent),
    });
    await assert.rejects(
      verifyConversationPtyPrerequisite({ proofFile, manifestDigest, buildDigest }),
      /generation/iu,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('duplicating one canonical turn cannot satisfy the two-turn prerequisite', async () => {
  const directory = await root();
  try {
    const proofFile = await sealedProof(directory, {}, { duplicateFirstTurn: true });
    await assert.rejects(
      verifyConversationPtyPrerequisite({ proofFile, manifestDigest, buildDigest }),
      /reuses an artifact path|reuse.*identity/iu,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('missing positive Provider usage cannot be replaced by a proof boolean', async () => {
  const directory = await root();
  try {
    const proofFile = await sealedProof(directory, {}, { zeroUsageTurn: 2 });
    await assert.rejects(
      verifyConversationPtyPrerequisite({ proofFile, manifestDigest, buildDigest }),
      /positive Provider usage/iu,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('helper transcript claims must match the sealed terminal bytes', async () => {
  const directory = await root();
  try {
    const proofFile = await sealedProof(directory, {}, { helperTranscriptSha256: 'f'.repeat(64) });
    await assert.rejects(
      verifyConversationPtyPrerequisite({ proofFile, manifestDigest, buildDigest }),
      /helper and terminal evidence are inconsistent/iu,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('helper Connector receipts and model action offsets are independently replayed', async () => {
  const cases: Array<[SealedProofFixtureOptions, RegExp]> = [
    [{ corruptConnectorReceiptTurn: 2 }, /helper action 2/iu],
    [{ overlapActionTurn: 2 }, /helper action 2/iu],
  ];
  for (const [fixture, expected] of cases) {
    const directory = await root();
    try {
      const proofFile = await sealedProof(directory, {}, fixture);
      await assert.rejects(
        verifyConversationPtyPrerequisite({ proofFile, manifestDigest, buildDigest }),
        expected,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
