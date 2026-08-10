import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  conversationEvidenceAttestationFile,
  conversationEvidenceOutcomeFile,
  type ConversationEvidenceOutcome,
} from './conversation-evidence-finalization.js';
import { auditPtyCanonicalChain } from './conversation-evidence-integrity.js';
import { verifyEvidenceSeal, type EvidenceSealFile } from './conversation-evidence-seal.js';
import { stripTerminalControl, terminalBytesContainAssistant } from './conversation-soak-contract.js';

interface PtyPrerequisiteProof {
  kind?: unknown;
  passed?: unknown;
  tty?: unknown;
  manifestDigest?: unknown;
  buildDigest?: unknown;
  retainedEvidenceIntegrityRequired?: unknown;
  startupObserved?: unknown;
  helperTranscriptProven?: unknown;
  privatePathTransformProven?: unknown;
  connectorIsolationProven?: unknown;
  transportChunksObserved?: unknown;
  assistantOutputVisibleAfterInputEcho?: unknown;
  canonicalChainProven?: unknown;
  toolSurfaceProven?: unknown;
  usageProven?: unknown;
  noncesInSession?: unknown;
  noncesInTerminal?: unknown;
  secretHits?: unknown;
  exitCode?: unknown;
  turns?: unknown;
  sourceTreeChanged?: unknown;
  runtimeClosureChanged?: unknown;
  rawRuntimeDeleted?: unknown;
  rawRuntimeRetainedExternally?: unknown;
  rawRuntimeQuarantinedExternally?: unknown;
  rawRuntimeFinalizationProven?: unknown;
  forcedShardKill?: unknown;
  canonicalEvidenceIndex?: unknown;
}

export interface VerifyConversationPtyPrerequisiteOptions {
  proofFile: string;
  manifestDigest: string;
  buildDigest: string;
}

const requiredNeedleKinds = [
  'credential-file',
  'credential-root',
  'private-home',
  'provider-secret',
  'runtime-root',
] as const;

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseObject<T>(bytes: Buffer, label: string): T {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as T;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function evidenceReference(value: unknown, label: string): { path: string; sha256: string; bytes: number } {
  const item = record(value);
  if (typeof item?.path !== 'string' || !item.path || path.isAbsolute(item.path)
    || path.posix.normalize(item.path) !== item.path || item.path.startsWith('../')
    || typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(item.sha256)
    || !Number.isSafeInteger(item.bytes) || (item.bytes as number) < 0) {
    throw new Error(`${label} is not one stable evidence reference`);
  }
  return { path: item.path, sha256: item.sha256, bytes: item.bytes as number };
}

async function readSealedArtifact(
  root: string,
  files: readonly EvidenceSealFile[],
  referenceValue: unknown,
  label: string,
): Promise<Buffer> {
  const reference = evidenceReference(referenceValue, label);
  const sealed = files.find((entry) => entry.path === reference.path);
  if (!sealed || sealed.sha256 !== reference.sha256 || sealed.bytes !== reference.bytes) {
    throw new Error(`${label} does not match the detached seal`);
  }
  const bytes = await readFile(path.join(root, reference.path));
  if (bytes.byteLength !== reference.bytes || sha256(bytes) !== reference.sha256) {
    throw new Error(`${label} bytes do not match the detached seal`);
  }
  return bytes;
}

async function replayCanonicalChain(
  root: string,
  files: readonly EvidenceSealFile[],
  proof: PtyPrerequisiteProof,
): Promise<void> {
  const indexBytes = await readSealedArtifact(
    root,
    files,
    proof.canonicalEvidenceIndex,
    'PTY canonical index',
  );
  const index = parseObject<Record<string, unknown>>(indexBytes, 'PTY canonical index');
  const artifacts = record(index.artifacts);
  const sessionBytes = await readSealedArtifact(root, files, artifacts?.session, 'PTY canonical Session');
  const traceBytes = await readSealedArtifact(root, files, artifacts?.trace, 'PTY canonical Trace');
  const helperBytes = await readSealedArtifact(root, files, artifacts?.helper, 'PTY helper result');
  const rawTerminal = await readSealedArtifact(root, files, artifacts?.rawTerminal, 'PTY raw terminal');
  const normalizedTerminal = await readSealedArtifact(
    root,
    files,
    artifacts?.normalizedTerminal,
    'PTY normalized terminal',
  );
  const session = parseObject<Record<string, unknown>>(sessionBytes, 'PTY canonical Session');
  if (!Array.isArray(session.items)) throw new Error('PTY canonical Session items are missing');
  const trace = traceBytes.toString('utf8').split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new Error('PTY canonical Trace is not valid JSONL');
    }
  });
  const helper = parseObject<Record<string, unknown>>(helperBytes, 'PTY helper result');
  const retainedTransform = record(helper.retainedTranscriptTransform);
  const helperActions = Array.isArray(helper.actions)
    ? helper.actions.flatMap((value) => {
      const entry = record(value);
      return entry ? [entry] : [];
    })
    : [];
  const modelActions = helperActions.filter((entry) => entry.kind === 'model_turn');
  if (helper.passed !== true || helper.tty !== true || helper.childTtyChecked !== true
    || helper.startupObserved !== true || helper.secretHits !== 0 || helper.exitCode !== 0
    || (helper.error !== null && helper.error !== undefined)
    || helper.transcriptBytes !== rawTerminal.byteLength
    || helper.transcriptSha256 !== sha256(rawTerminal)
    || retainedTransform?.schemaVersion !== 1
    || retainedTransform.algorithm !== 'equal-byte-private-needle-v1'
    || !Number.isSafeInteger(retainedTransform.replacements)
    || (retainedTransform.replacements as number) < 0
    || !Array.isArray(retainedTransform.needleKinds)
    || !retainedTransform.needleKinds.every((value) => typeof value === 'string')
    || normalizedTerminal.toString('utf8') !== stripTerminalControl(rawTerminal.toString('utf8'))) {
    throw new Error('PTY helper and terminal evidence are inconsistent');
  }
  if (index.kind !== 'persistent-pty-canonical-evidence-index'
    || typeof index.sessionId !== 'string'
    || !Array.isArray(index.turns)
    || index.turns.length < 2
    || proof.turns !== index.turns.length) {
    throw new Error('PTY canonical index header is invalid');
  }
  if (modelActions.length !== index.turns.length) {
    throw new Error('PTY helper model action count does not equal the canonical turn count');
  }
  const uniqueNonces = new Set<string>();
  const uniqueEventIds = new Set<string>();
  const uniqueTaskIds = new Set<string>();
  const uniqueDaemonRunIds = new Set<string>();
  const uniqueRuntimeRunIds = new Set<string>();
  const uniqueTurnArtifacts = new Set<string>();
  const exactConnectorConfigDigest = sha256(Buffer.from('{"connectors":{}}\n'));
  let previousActionEnd = -1;
  for (const [position, value] of index.turns.entries()) {
    const turn = record(value);
    const turnArtifacts = record(turn?.artifacts);
    const eventReference = evidenceReference(turnArtifacts?.event, `PTY turn ${position + 1} Event`);
    const taskReference = evidenceReference(turnArtifacts?.task, `PTY turn ${position + 1} Task`);
    const runReference = evidenceReference(turnArtifacts?.run, `PTY turn ${position + 1} Run`);
    for (const reference of [eventReference, taskReference, runReference]) {
      if (uniqueTurnArtifacts.has(reference.path)) {
        throw new Error(`PTY canonical turn ${position + 1} reuses an artifact path`);
      }
      uniqueTurnArtifacts.add(reference.path);
    }
    const [eventBytes, taskBytes, runBytes] = await Promise.all([
      readSealedArtifact(root, files, eventReference, `PTY turn ${position + 1} Event`),
      readSealedArtifact(root, files, taskReference, `PTY turn ${position + 1} Task`),
      readSealedArtifact(root, files, runReference, `PTY turn ${position + 1} Run`),
    ]);
    const event = parseObject<Record<string, unknown>>(eventBytes, `PTY turn ${position + 1} Event`);
    const task = parseObject<Record<string, unknown>>(taskBytes, `PTY turn ${position + 1} Task`);
    const run = parseObject<Record<string, unknown>>(runBytes, `PTY turn ${position + 1} Run`);
    const prompt = record(event.payload)?.prompt;
    const nonce = turn?.nonce;
    const answer = record(run.answer)?.answer;
    if (turn?.turn !== position + 1 || typeof prompt !== 'string'
      || typeof nonce !== 'string' || !prompt.includes(nonce)
      || typeof answer !== 'string' || typeof turn?.eventId !== 'string'
      || typeof turn.daemonRunId !== 'string' || typeof turn.taskId !== 'string'
      || typeof turn.runtimeRunId !== 'string') {
      throw new Error(`PTY canonical turn ${position + 1} metadata is incomplete`);
    }
    const identities: Array<[Set<string>, string, string]> = [
      [uniqueNonces, nonce, 'nonce'],
      [uniqueEventIds, turn.eventId, 'Event'],
      [uniqueTaskIds, turn.taskId, 'Task'],
      [uniqueDaemonRunIds, turn.daemonRunId, 'Daemon Run'],
      [uniqueRuntimeRunIds, turn.runtimeRunId, 'runtime Run'],
    ];
    for (const [seen, identity, label] of identities) {
      if (seen.has(identity)) throw new Error(`PTY canonical turns reuse a ${label} identity`);
      seen.add(identity);
    }
    if (event.id !== turn.eventId) throw new Error(`PTY canonical turn ${position + 1} Event id is inconsistent`);
    const usage = record(record(run.answer)?.usage);
    const inputTokens = usage?.runInputTokens ?? usage?.inputTokens;
    const outputTokens = usage?.runOutputTokens ?? usage?.outputTokens;
    if (typeof inputTokens !== 'number' || !Number.isFinite(inputTokens) || inputTokens <= 0
      || typeof outputTokens !== 'number' || !Number.isFinite(outputTokens) || outputTokens <= 0) {
      throw new Error(`PTY canonical turn ${position + 1} has no positive Provider usage`);
    }
    const helperAction = modelActions[position];
    const helperRun = record(helperAction?.modelRun);
    const connectorIsolation = record(helperAction?.connectorIsolation);
    const start = helperAction?.startRawOffset;
    const end = helperAction?.endRawOffset;
    if (helperAction?.index !== position + 1
      || connectorIsolation?.proven !== true || connectorIsolation.connectorCount !== 0
      || connectorIsolation.configSha256 !== exactConnectorConfigDigest
      || helperRun?.daemonRunId !== turn.daemonRunId || helperRun.taskId !== turn.taskId
      || helperRun.status !== 'completed' || helperRun.provenTerminal !== true
      || helperRun.promptReadyAfterBusy !== true || helperRun.transportChunksObserved !== true
      || typeof helperRun.inputTokens !== 'number' || helperRun.inputTokens <= 0
      || typeof helperRun.outputTokens !== 'number' || helperRun.outputTokens <= 0
      || helperRun.inputTokens !== inputTokens || helperRun.outputTokens !== outputTokens
      || typeof start !== 'number' || typeof end !== 'number'
      || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < previousActionEnd || end <= start || end > rawTerminal.byteLength
      || !terminalBytesContainAssistant(rawTerminal, start, end, answer, prompt)) {
      throw new Error(`PTY helper action ${position + 1} does not bind the canonical assistant output`);
    }
    previousActionEnd = end;
    const audit = auditPtyCanonicalChain({
      event,
      task,
      run,
      trace,
      sessionItems: session.items,
      sessionId: index.sessionId,
      prompt,
      nonce,
      assistantText: answer,
      daemonRunId: turn.daemonRunId,
      taskId: turn.taskId,
      helperRuntimeRunId: turn.runtimeRunId,
    });
    if (!audit.proven || audit.runtimeRunId !== turn.runtimeRunId
      || record(turn.chainProof)?.proven !== true) {
      throw new Error(`PTY canonical turn ${position + 1} chain replay failed: ${audit.reasons.join('; ')}`);
    }
  }
}

export async function verifyConversationPtyPrerequisite(
  options: VerifyConversationPtyPrerequisiteOptions,
): Promise<void> {
  const proofFile = path.resolve(options.proofFile);
  const root = path.dirname(proofFile);
  const proofRelative = path.basename(proofFile);
  if (proofRelative !== 'pty-smoke.proof.json') {
    throw new Error('PTY prerequisite proof must be the canonical pty-smoke.proof.json artifact');
  }
  const first = await verifyEvidenceSeal(root, conversationEvidenceAttestationFile, {
    expectedGeneration: 0,
    expectedParentIndexHash: null,
  });
  if (first.manifest.files.some((entry) => entry.role === 'correction')) {
    throw new Error('PTY prerequisite generation 0 cannot contain correction artifacts');
  }
  const proofBytes = await readFile(proofFile);
  const outcomeFile = path.join(root, conversationEvidenceOutcomeFile);
  const outcomeBytes = await readFile(outcomeFile);
  const proofEntry = first.manifest.files.find((entry) => entry.path === proofRelative);
  const outcomeEntry = first.manifest.files.find((entry) => entry.path === conversationEvidenceOutcomeFile);
  if (!proofEntry || proofEntry.sha256 !== sha256(proofBytes) || proofEntry.bytes !== proofBytes.byteLength
    || !outcomeEntry || outcomeEntry.sha256 !== sha256(outcomeBytes)
    || outcomeEntry.bytes !== outcomeBytes.byteLength) {
    throw new Error('PTY prerequisite proof or outcome does not match its detached seal');
  }

  const proof = parseObject<PtyPrerequisiteProof>(proofBytes, 'PTY prerequisite proof');
  const outcome = parseObject<ConversationEvidenceOutcome>(outcomeBytes, 'PTY prerequisite outcome');
  if (proof.kind !== 'persistent-pty-prerequisite'
    || proof.passed !== true
    || proof.tty !== true
    || proof.startupObserved !== true
    || proof.helperTranscriptProven !== true
    || proof.privatePathTransformProven !== true
    || proof.connectorIsolationProven !== true
    || proof.transportChunksObserved !== true
    || proof.assistantOutputVisibleAfterInputEcho !== true
    || proof.canonicalChainProven !== true
    || proof.toolSurfaceProven !== true
    || proof.usageProven !== true
    || proof.noncesInSession !== true
    || proof.noncesInTerminal !== true
    || proof.secretHits !== 0
    || proof.exitCode !== 0
    || !Number.isSafeInteger(proof.turns) || (proof.turns as number) < 2
    || proof.sourceTreeChanged !== false
    || proof.runtimeClosureChanged !== false
    || proof.rawRuntimeDeleted !== true
    || proof.rawRuntimeRetainedExternally !== false
    || proof.rawRuntimeQuarantinedExternally !== false
    || proof.rawRuntimeFinalizationProven !== true
    || proof.forcedShardKill !== false
    || proof.manifestDigest !== options.manifestDigest
    || proof.buildDigest !== options.buildDigest
    || proof.retainedEvidenceIntegrityRequired !== true
    || outcome.schemaVersion !== 1
    || outcome.kind !== 'conversation-evidence-outcome'
    || outcome.proofEligible !== true
    || outcome.manifestDigest !== options.manifestDigest
    || outcome.buildDigest !== options.buildDigest
    || JSON.stringify(outcome.checkedNeedleKinds) !== JSON.stringify(requiredNeedleKinds)
    || !Array.isArray(outcome.privacyFailures)
    || outcome.privacyFailures.length !== 0) {
    throw new Error('PTY prerequisite is missing, failed, private, or belongs to a different manifest/build');
  }
  await replayCanonicalChain(root, first.manifest.files, proof);
  await verifyEvidenceSeal(root, conversationEvidenceAttestationFile, {
    expectedGeneration: 0,
    expectedParentIndexHash: null,
  });
}
