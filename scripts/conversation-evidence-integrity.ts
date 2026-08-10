import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const SCAN_CHUNK_BYTES = 64 * 1024;

export interface PrivateEvidenceNeedle {
  kind: 'provider-secret' | 'private-home' | 'credential-root' | 'credential-file' | 'runtime-root';
  value: string | Buffer;
}

export interface EvidenceFileDigest {
  path: string;
  sha256: string;
  bytes: number;
  mode: number;
  role: string;
  generation: 0;
}

export interface RetainedEvidenceScan {
  schemaVersion: 1;
  treeDigest: string;
  files: EvidenceFileDigest[];
  fileCount: number;
  bytes: number;
  checkedNeedleKinds: PrivateEvidenceNeedle['kind'][];
}

export interface PtyCanonicalChainInput {
  event: unknown;
  task: unknown;
  run: unknown;
  trace: readonly unknown[];
  sessionItems: readonly unknown[];
  sessionId: string;
  prompt: string;
  nonce: string;
  assistantText?: string;
  daemonRunId: string;
  taskId: string;
  helperRuntimeRunId?: string;
}

export interface PtyCanonicalChainAudit {
  proven: boolean;
  runtimeRunId?: string;
  reasons: string[];
}

export type RawRuntimeRetentionReason = 'startup-failure' | 'functional-failure' | 'forced-shard-kill';

export interface RawRuntimeFinalization {
  retainedExternally: boolean;
  rawRuntimeDeleted: boolean;
  quarantineDigest?: string;
  retentionReason?: RawRuntimeRetentionReason;
}

export async function finalizeExternalRawRuntime(
  runtimeRoot: string,
  evidenceRoot: string,
  retentionReason?: RawRuntimeRetentionReason,
): Promise<RawRuntimeFinalization> {
  const root = path.resolve(runtimeRoot);
  const evidence = path.resolve(evidenceRoot);
  const relative = path.relative(evidence, root);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('raw runtime finalization refuses an evidence-contained root');
  }
  if (!path.basename(root).startsWith('mimi-cr-')) {
    throw new Error('raw runtime finalization refuses an unrecognized root');
  }
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('raw runtime finalization requires a physical directory');
  }
  assertPrivateMode(metadata, 0o700, 'root', 'external-runtime');
  if (retentionReason) {
    return {
      retainedExternally: true,
      rawRuntimeDeleted: false,
      quarantineDigest: createHash('sha256').update(`runtime-quarantine-v1\0${root}`).digest('hex'),
      retentionReason,
    };
  }
  await rm(root, { recursive: true, force: true });
  return { retainedExternally: false, rawRuntimeDeleted: true };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function protocolText(value: unknown): string {
  const entry = object(value);
  if (!entry) return '';
  if (typeof entry.content === 'string') return entry.content;
  if (typeof entry.text === 'string') return entry.text;
  if (!Array.isArray(entry.content)) return '';
  return entry.content.flatMap((part) => {
    if (typeof part === 'string') return [part];
    const content = object(part);
    return typeof content?.text === 'string' ? [content.text] : [];
  }).join('');
}

function protocolRole(value: unknown): string | undefined {
  const role = object(value)?.role;
  return typeof role === 'string' ? role : undefined;
}

function protocolType(value: unknown): string | undefined {
  const type = object(value)?.type;
  return typeof type === 'string' ? type : undefined;
}

function protocolCallId(value: unknown): string | undefined {
  const entry = object(value);
  const camel = entry?.callId;
  const snake = entry?.call_id;
  if (camel !== undefined && snake !== undefined && camel !== snake) return undefined;
  const id = camel ?? snake;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function aliasValue(
  entry: Record<string, unknown> | undefined,
  aliases: readonly string[],
  label: string,
  reasons: string[],
): string | undefined {
  const present = aliases.flatMap((alias) => {
    if (!entry || !Object.hasOwn(entry, alias)) return [];
    const value = entry[alias];
    if (typeof value !== 'string' || value.length === 0) {
      reasons.push(`${label} alias ${alias} is invalid`);
      return [];
    }
    return [{ alias, value }];
  });
  if (new Set(present.map(({ value }) => value)).size > 1) {
    reasons.push(`${label} aliases disagree`);
  }
  return present[0]?.value;
}

function auditSessionTurn(input: PtyCanonicalChainInput, reasons: string[]): void {
  const items = input.sessionItems;
  const userIndexes = items.flatMap((item, index) => (
    protocolRole(item) === 'user' && protocolText(item) === input.prompt ? [index] : []
  ));
  const nonceUserIndexes = items.flatMap((item, index) => (
    protocolRole(item) === 'user' && protocolText(item).includes(input.nonce) ? [index] : []
  ));
  if (!input.prompt.includes(input.nonce) || userIndexes.length !== 1
    || nonceUserIndexes.length !== 1 || nonceUserIndexes[0] !== userIndexes[0]) {
    reasons.push('Session does not contain exactly one canonical user unit for the PTY nonce');
  }
  const userIndex = userIndexes[0];
  if (userIndex === undefined) return;
  const nextUserOffset = items.slice(userIndex + 1)
    .findIndex((item) => protocolRole(item) === 'user');
  const turnEnd = nextUserOffset < 0 ? items.length : userIndex + 1 + nextUserOffset;
  const turn = items.slice(userIndex, turnEnd);
  const assistantOffsets = turn.flatMap((item, index) => (
    protocolRole(item) === 'assistant' ? [index] : []
  ));
  const canonicalAssistantOffsets = assistantOffsets.filter((index) => (
    input.assistantText !== undefined
      && protocolText(turn[index]).includes(input.nonce)
      && protocolText(turn[index]) === input.assistantText
  ));
  const nonceAssistants = items.filter((item) => (
    protocolRole(item) === 'assistant' && protocolText(item).includes(input.nonce)
  ));
  if (assistantOffsets.length !== 1 || canonicalAssistantOffsets.length !== 1
    || nonceAssistants.length !== 1) {
    reasons.push('Session turn does not contain exactly one canonical assistant unit for the PTY nonce');
  }
  const assistantOffset = assistantOffsets[0];
  if (assistantOffset === undefined) return;
  if (assistantOffset !== turn.length - 1) {
    reasons.push('Session assistant is not the final protocol unit for the turn');
  }
  for (let index = 1; index < turn.length; index += 1) {
    const item = turn[index];
    const role = protocolRole(item);
    const type = protocolType(item);
    if (role === 'assistant' || type === 'function_call' || type === 'function_call_result') continue;
    reasons.push(`Session turn contains unsupported protocol unit at offset ${index}`);
  }

  const calls = new Map<string, number[]>();
  const results = new Map<string, number[]>();
  for (let index = 1; index < turn.length; index += 1) {
    const item = turn[index];
    const type = protocolType(item);
    if (type !== 'function_call' && type !== 'function_call_result') continue;
    const id = protocolCallId(item);
    if (!id) {
      reasons.push(`Session ${type} is missing one consistent call id`);
      continue;
    }
    const target = type === 'function_call' ? calls : results;
    target.set(id, [...target.get(id) ?? [], index]);
  }
  for (const id of new Set([...calls.keys(), ...results.keys()])) {
    const callIndexes = calls.get(id) ?? [];
    const resultIndexes = results.get(id) ?? [];
    if (callIndexes.length !== 1 || resultIndexes.length !== 1) {
      reasons.push(`Session tool pair ${id} is not exactly 1:1`);
      continue;
    }
    if (resultIndexes[0]! <= callIndexes[0]!) {
      reasons.push(`Session tool result ${id} does not follow its call`);
    }
    if (callIndexes[0]! >= assistantOffset || resultIndexes[0]! >= assistantOffset) {
      reasons.push(`Session tool pair ${id} does not precede the assistant`);
    }
  }
  if (calls.size > 0 || results.size > 0) {
    reasons.push('Session tool protocol contradicts the empty advertised Tool surface');
  }
}

function traceData(entry: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return object(entry?.data);
}

function auditTraceTurn(
  input: PtyCanonicalChainInput,
  runtimeRunId: string | undefined,
  reasons: string[],
): void {
  const before = reasons.length;
  const trace = input.trace.map(object);
  const starts = trace.flatMap((entry, index) => (
    entry?.type === 'turn_start' && traceData(entry)?.input === input.prompt ? [index] : []
  ));
  if (starts.length !== 1) reasons.push(`Trace must contain exactly one turn_start; observed ${starts.length}`);
  const start = starts[0];
  if (start === undefined) {
    reasons.push('Trace does not contain exactly one strictly ordered Run-bound turn segment');
    return;
  }
  const nextStartOffset = trace.slice(start + 1).findIndex((entry) => entry?.type === 'turn_start');
  const windowEnd = nextStartOffset < 0 ? trace.length : start + 1 + nextStartOffset;
  const indexes = Array.from({ length: windowEnd - start }, (_, offset) => start + offset);
  const ofType = (type: string) => indexes.filter((index) => trace[index]?.type === type);
  const bindingIndexes = ofType('model_binding_event');
  const surfaceIndexes = ofType('model_tool_surface');
  const finalizationIndexes = ofType('run_finalization');
  const endIndexes = ofType('turn_end');
  const contradictoryIndexes = indexes.filter((index) => (
    trace[index]?.type === 'error' || trace[index]?.type === 'turn_interrupted'
  ));
  if (contradictoryIndexes.length > 0) {
    reasons.push('Trace completed window contains an error or interruption event');
  }
  for (const [type, found] of [
    ['model_binding_event', bindingIndexes],
    ['model_tool_surface', surfaceIndexes],
    ['run_finalization', finalizationIndexes],
    ['turn_end', endIndexes],
  ] as const) {
    if (found.length !== 1) reasons.push(`Trace must contain exactly one ${type}; observed ${found.length}`);
  }
  const bindingIndex = bindingIndexes[0];
  const surfaceIndex = surfaceIndexes[0];
  const finalizationIndex = finalizationIndexes[0];
  const endIndex = endIndexes[0];
  const requiredIndexes = [start, bindingIndex, surfaceIndex, finalizationIndex, endIndex];
  if (requiredIndexes.some((index) => index === undefined)
    || requiredIndexes.some((index, position) => position > 0 && index! <= requiredIndexes[position - 1]!)) {
    reasons.push('Trace lifecycle is not strictly ordered start -> binding -> tool surface -> finalization -> end');
  }

  for (const index of requiredIndexes) {
    if (index !== undefined && trace[index]?.sessionId !== input.sessionId) {
      reasons.push('Trace lifecycle Session does not equal the PTY Session');
    }
  }
  const binding = bindingIndex === undefined ? undefined : trace[bindingIndex];
  const bindingData = traceData(binding);
  if (bindingData?.workUnitKind !== 'conversation' || bindingData?.workUnitId !== runtimeRunId) {
    reasons.push('Trace model binding does not equal the canonical conversation runtime Run');
  }
  const surface = surfaceIndex === undefined ? undefined : trace[surfaceIndex];
  const surfaceData = traceData(surface);
  const emptyToolDigest = `sha256:${createHash('sha256').update('[]').digest('hex')}`;
  if (surfaceData?.phase !== 'before_model_dispatch'
    || surfaceData?.runId !== runtimeRunId
    || !Array.isArray(surfaceData?.advertisedTools)
    || surfaceData.advertisedTools.length !== 0
    || surfaceData?.advertisedToolCount !== 0
    || surfaceData?.toolSetDigest !== emptyToolDigest) {
    reasons.push('Trace model tool surface is not the empty pre-dispatch surface for the runtime Run');
  }
  const finalization = finalizationIndex === undefined ? undefined : trace[finalizationIndex];
  const finalizationData = traceData(finalization);
  if (finalizationData?.runId !== runtimeRunId || finalizationData?.outcome !== 'completed') {
    reasons.push('Trace finalization does not complete the canonical runtime Run');
  }
  const end = endIndex === undefined ? undefined : trace[endIndex];
  if (traceData(end)?.answer !== input.assistantText) {
    reasons.push('Trace turn_end answer does not equal the canonical Session answer');
  }

  const runtimeTraceEntries = trace.filter((entry) => {
    const data = traceData(entry);
    return (entry?.type === 'model_binding_event' && data?.workUnitId === runtimeRunId)
      || (entry?.type === 'model_tool_surface' && data?.runId === runtimeRunId)
      || (entry?.type === 'run_finalization' && data?.runId === runtimeRunId);
  });
  if (runtimeRunId && runtimeTraceEntries.length !== 3) {
    reasons.push('Trace contains duplicate or missing lifecycle evidence for the runtime Run');
  }
  const stale = indexes.some((index) => {
    const entry = trace[index];
    const data = traceData(entry);
    if (entry?.type === 'model_binding_event') return data?.workUnitId !== runtimeRunId;
    if (entry?.type === 'model_tool_surface' || entry?.type === 'run_finalization') {
      return data?.runId !== runtimeRunId;
    }
    return false;
  });
  if (stale) reasons.push('Trace contains stale runtime Run lifecycle evidence inside the PTY turn');
  if (reasons.length !== before) {
    reasons.push('Trace does not contain exactly one strictly ordered Run-bound turn segment');
  }
}

export function auditPtyCanonicalChain(input: PtyCanonicalChainInput): PtyCanonicalChainAudit {
  const reasons: string[] = [];
  const event = object(input.event);
  const task = object(input.task);
  const run = object(input.run);
  const eventId = typeof event?.id === 'string' ? event.id : undefined;
  const taskId = aliasValue(task, ['taskId', 'id'], 'Task id', reasons);
  const taskEventId = aliasValue(
    task, ['triggerEventId', 'authorityEventId', 'eventId'], 'Task Event', reasons,
  );
  const taskSessionId = aliasValue(task, ['sessionId', 'sessionKey'], 'Task Session', reasons);
  const taskProfileId = aliasValue(task, ['profileId'], 'Task profile', reasons);
  const eventSessionId = aliasValue(event, ['sessionKey'], 'Event Session', reasons);
  const eventPrompt = object(event?.payload)?.prompt;
  if (!eventId) reasons.push('Event id is missing');
  if (event?.source !== 'local-cli' || event?.trust !== 'owner') {
    reasons.push('Event is not the local owner CLI authority');
  }
  if (event?.profileId !== 'owner') {
    reasons.push('Event does not use the owner profile');
  }
  if (taskProfileId !== 'owner') {
    reasons.push('Task profile is not the owner profile');
  }
  if (event?.profileId !== taskProfileId) {
    reasons.push('Event profile does not equal the Task profile');
  }
  if (eventSessionId !== input.sessionId) {
    reasons.push('Event Session does not equal the PTY Session');
  }
  if (taskSessionId !== eventSessionId) {
    reasons.push('Task Session does not equal the Event Session');
  }
  if (eventPrompt !== input.prompt) reasons.push('Event prompt does not equal the PTY input');
  if (taskId !== input.taskId) reasons.push('Task id does not equal the PTY Daemon receipt');
  if (taskEventId !== eventId) reasons.push('Task trigger Event does not equal Event.id');
  if (task?.status !== 'completed') reasons.push('Task is not completed');
  if (taskSessionId !== input.sessionId) reasons.push('Task Session does not equal the PTY Session');
  if (run?.id !== input.daemonRunId) reasons.push('Daemon Run id does not equal the PTY receipt');
  if (run?.taskId !== input.taskId) reasons.push('Daemon Run.taskId does not equal Task.id');
  if (run?.sessionKey !== input.sessionId) reasons.push('Daemon Run Session does not equal the PTY Session');
  if (run?.status !== 'completed') reasons.push('Daemon Run is not completed');
  const answer = object(run?.answer);
  const finalization = object(answer?.finalization);
  const runtimeRunId = typeof finalization?.runId === 'string' ? finalization.runId : undefined;
  if (!runtimeRunId) reasons.push('Run finalization runtimeRunId is missing');
  if (finalization?.outcome !== 'completed') reasons.push('Run finalization is not completed');
  if (input.helperRuntimeRunId !== undefined && input.helperRuntimeRunId !== runtimeRunId) {
    reasons.push('PTY helper runtime Run does not equal the canonical Run finalization');
  }
  if (!input.assistantText || input.assistantText !== answer?.answer || !input.assistantText.includes(input.nonce)) {
    reasons.push('Session assistant answer does not equal the canonical Run answer and nonce');
  }
  auditSessionTurn(input, reasons);
  auditTraceTurn(input, runtimeRunId, reasons);
  return { proven: reasons.length === 0, runtimeRunId, reasons };
}

function normalizedNeedles(values: readonly PrivateEvidenceNeedle[]): Array<{
  kind: PrivateEvidenceNeedle['kind'];
  bytes: Buffer;
}> {
  const seen = new Set<string>();
  const needles = values.map(({ kind, value }) => {
    const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, 'utf8');
    if (bytes.byteLength === 0) throw new Error(`private evidence needle ${kind} is empty`);
    return { kind, bytes };
  }).filter(({ kind, bytes }) => {
    const key = `${kind}\0${bytes.toString('base64')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (needles.length === 0) throw new Error('at least one private evidence needle is required');
  return needles.sort((left, right) => right.bytes.byteLength - left.bytes.byteLength
    || left.kind.localeCompare(right.kind));
}

function stableFile(before: Stats, after: Stats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.mode === after.mode
    && before.uid === after.uid
    && before.nlink === after.nlink;
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('retained evidence privacy gate requires a current uid');
  return uid;
}

function assertPrivateMode(metadata: Stats, expectedMode: number, role: 'root' | 'directory' | 'file', relative: string): void {
  if (metadata.uid !== currentUid() || (metadata.mode & 0o777) !== expectedMode) {
    throw new Error(`retained evidence ${role} is not private: ${relative || '.'}`);
  }
}

function evidenceRole(relative: string): string {
  const basename = path.posix.basename(relative);
  if (relative.startsWith('pty-smoke-canonical/') || relative.startsWith('canonical/')
    || relative.startsWith('turns/')) return 'canonical-entity';
  if (/terminal\.(?:ansi|txt)$/u.test(basename)) return 'terminal-transcript';
  if (basename === 'evidence.jsonl') return 'protocol-journal';
  if (basename === 'checkpoint.json') return 'checkpoint';
  if (basename === 'manifest.json') return 'scenario-manifest';
  if (basename === 'build.log') return 'build-log';
  if (basename.endsWith('.proof.json')) return 'proof';
  if (basename.endsWith('.canonical-index.json')) return 'canonical-index';
  return 'benchmark-metadata';
}

function forbiddenEvidenceBasename(name: string): boolean {
  return name === 'control.token'
    || name === '.env'
    || name === '.owner'
    || name === 'socket'
    || name.endsWith('.socket');
}

function obviousSecretPattern(value: Buffer): boolean {
  const text = value.toString('utf8');
  if (/\bBearer\s+(?!<|\$\{)(?:[A-Za-z0-9._~+\/-]){12,}/u.test(text)) return true;
  if (/\bsk-[A-Za-z0-9_-]{12,}/u.test(text)) return true;
  const matches = text.matchAll(/\b[A-Z][A-Z0-9_]{2,}_API_KEY\s*=\s*["']?([^\s"']{8,})/gu);
  for (const match of matches) {
    const candidate = match[1]?.toLowerCase() ?? '';
    if (!/^(?:<|\$\{|placeholder|example|test|synthetic|redacted)/u.test(candidate)) return true;
  }
  return false;
}

export class RetainedEvidencePrivacyError extends Error {
  readonly kind: PrivateEvidenceNeedle['kind'] | 'forbidden-name' | 'secret-pattern';
  readonly evidencePath: string;

  constructor(kind: PrivateEvidenceNeedle['kind'] | 'forbidden-name' | 'secret-pattern', evidencePath: string) {
    super(`retained evidence privacy gate found ${kind} bytes in ${evidencePath}`);
    this.name = 'RetainedEvidencePrivacyError';
    this.kind = kind;
    this.evidencePath = evidencePath;
  }
}

export async function scanRetainedEvidenceTree(
  root: string,
  privateValues: readonly PrivateEvidenceNeedle[],
): Promise<RetainedEvidenceScan> {
  const canonicalRoot = path.resolve(root);
  const rootMetadata = await lstat(canonicalRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('retained evidence root must be a physical directory');
  }
  assertPrivateMode(rootMetadata, 0o700, 'root', '');
  const needles = normalizedNeedles(privateValues);
  const maximumNeedleBytes = Math.max(...needles.map(({ bytes }) => bytes.byteLength));
  const files: EvidenceFileDigest[] = [];

  const visit = async (directory: string, relativeRoot: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = path.posix.join(relativeRoot, entry.name);
      const absolute = path.join(directory, entry.name);
      if (forbiddenEvidenceBasename(entry.name)) {
        throw new RetainedEvidencePrivacyError('forbidden-name', relative);
      }
      const pathBytes = Buffer.from(relative, 'utf8');
      for (const needle of needles) {
        if (pathBytes.includes(needle.bytes)) throw new RetainedEvidencePrivacyError(needle.kind, relative);
      }
      const metadata = await lstat(absolute);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        assertPrivateMode(metadata, 0o700, 'directory', relative);
        await visit(absolute, relative);
        continue;
      }
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`retained evidence contains unsupported entry ${relative}`);
      }
      const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (!before.isFile()) throw new Error(`retained evidence entry is not a physical file: ${relative}`);
        assertPrivateMode(before, 0o600, 'file', relative);
        if (before.nlink !== 1) throw new Error(`retained evidence file has multiple links: ${relative}`);
        const digest = createHash('sha256');
        const chunk = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
        let carry = Buffer.alloc(0);
        let bytesRead = 0;
        for (;;) {
          const result = await handle.read(chunk, 0, chunk.byteLength, bytesRead);
          if (result.bytesRead === 0) break;
          const current = Buffer.from(chunk.subarray(0, result.bytesRead));
          digest.update(current);
          bytesRead += result.bytesRead;
          const searchable = carry.byteLength > 0 ? Buffer.concat([carry, current]) : current;
          for (const needle of needles) {
            if (searchable.includes(needle.bytes)) {
              throw new RetainedEvidencePrivacyError(needle.kind, relative);
            }
          }
          if (obviousSecretPattern(searchable)) {
            throw new RetainedEvidencePrivacyError('secret-pattern', relative);
          }
          const carryBytes = Math.min(searchable.byteLength, Math.max(maximumNeedleBytes - 1, 8_192));
          carry = carryBytes > 0 ? Buffer.from(searchable.subarray(searchable.byteLength - carryBytes)) : Buffer.alloc(0);
        }
        const after = await handle.stat();
        if (!stableFile(before, after) || bytesRead !== after.size) {
          throw new Error(`retained evidence changed while scanning ${relative}`);
        }
        files.push({
          path: relative,
          sha256: digest.digest('hex'),
          bytes: bytesRead,
          mode: after.mode & 0o777,
          role: evidenceRole(relative),
          generation: 0,
        });
      } finally {
        await handle.close();
      }
    }
  };

  await visit(canonicalRoot, '');
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    schemaVersion: 1,
    treeDigest: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    files,
    fileCount: files.length,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
    checkedNeedleKinds: [...new Set(needles.map(({ kind }) => kind))].sort(),
  };
}
