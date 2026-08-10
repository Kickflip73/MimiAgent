import { execFile, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, type BigIntStats } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';

const markerName = '.runtime-owner.json';
const stagingPrefix = 'mimi-cr-staging-';
const quarantinePrefix = 'mimi-cr-quarantine-';
const lifecycleSchemaVersion = 1 as const;
const processInstanceId = randomUUID();
const processStartedAt = new Date().toISOString();
const defaultSnapshotLimits = {
  maxFiles: 100_000,
  maxBytes: 10 * 1024 * 1024 * 1024,
  chunkBytes: 64 * 1024,
};

export type RawRuntimeRetentionReason =
  | 'startup-failure'
  | 'functional-failure'
  | 'forced-shard-kill';

export interface RawRuntimeOwnerIdentity {
  pid: number;
  instanceId: string;
  startedAt: string;
  pgid?: number;
  processStartIdentity?: string;
}

export interface RawRuntimeDaemonIdentity {
  pid: number;
  pgid?: number;
  processStartIdentity?: string;
}

export interface RawRuntimeProcessIdentity {
  pid: number;
  pgid: number;
  processStartIdentity: string;
}

export type RawRuntimeProcessProbe =
  | { status: 'alive'; identity: RawRuntimeProcessIdentity }
  | { status: 'dead' }
  | { status: 'unknown' };

interface RootCreationIdentity {
  device: string;
  inode: string;
}

interface RuntimeTreeSnapshot {
  treeDigest: string;
  bytes: number;
  fileCount: number;
}

interface RuntimeQuarantineMetadata extends RuntimeTreeSnapshot {
  reason: RawRuntimeRetentionReason;
  quarantinedAt: string;
}

interface RuntimeOwnerMarker {
  schemaVersion: typeof lifecycleSchemaVersion;
  identity: string;
  state: 'staging' | 'quarantine';
  createdAt: string;
  creation: RootCreationIdentity;
  owner: RawRuntimeOwnerIdentity;
  daemon?: RawRuntimeDaemonIdentity;
  quarantine?: RuntimeQuarantineMetadata;
}

export interface ControlledRawRuntime {
  root: string;
  storageRoot: string;
  identity: string;
  createdAt: string;
  creation: RootCreationIdentity;
  owner: RawRuntimeOwnerIdentity;
  daemon?: RawRuntimeDaemonIdentity;
}

export interface CreateControlledRawRuntimeOptions {
  storageRoot: string;
  now?: () => Date;
  identityFactory?: () => string;
  owner?: RawRuntimeOwnerIdentity;
}

export type RawRuntimeFinalization =
  | {
    state: 'deleted';
    rawRuntimeDeleted: true;
  }
  | {
    state: 'quarantined';
    rawRuntimeDeleted: false;
    quarantineId: string;
    treeDigest: string;
    bytes: number;
    fileCount: number;
    createdAt: string;
    quarantinedAt: string;
    reason: RawRuntimeRetentionReason;
  };

export interface RuntimeRecoveryOptions {
  storageRoot: string;
  now?: () => Date;
  stagingGraceMs: number;
  quarantineGraceMs: number;
  quotaBytes: number;
  ownerIsLive?: (owner: RawRuntimeOwnerIdentity) => boolean | Promise<boolean>;
  processIdentityProbe?: (pid: number) => RawRuntimeProcessProbe | Promise<RawRuntimeProcessProbe>;
  snapshotLimits?: Partial<typeof defaultSnapshotLimits>;
}

export interface RuntimeRecoveryReport {
  schemaVersion: typeof lifecycleSchemaVersion;
  scannedRoots: number;
  preservedLiveRoots: number;
  preservedUnknownRoots: number;
  preservedYoungRoots: number;
  removedStagingRoots: number;
  removedQuarantineRoots: number;
  reclaimedBytes: number;
  usedBytes: number;
  quotaBytes: number;
  quotaExceeded: boolean;
}

export interface ExitObservableProcess {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once(event: 'exit', listener: () => void): unknown;
  removeListener(event: 'exit', listener: () => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface TerminateProcessOptions {
  gracefulWaitMs: number;
  killWaitMs: number;
  signal?: (child: ExitObservableProcess, signal: NodeJS.Signals) => void;
}

export interface TerminateProcessResult {
  exited: boolean;
  forced: boolean;
  killTimedOut: boolean;
}

interface StableStat {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  mode: bigint;
  uid: bigint;
  nlink: bigint;
}

interface RecoveryCandidate {
  root: string;
  kind: 'staging' | 'quarantine';
  marker?: RuntimeOwnerMarker;
  markerBytes: number;
  snapshot: RuntimeTreeSnapshot;
  rootStat: StableStat;
  liveness: 'live' | 'dead' | 'unknown';
  expired: boolean;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`raw runtime lifecycle ${name} must be a positive safe integer`);
  }
  return value;
}

function validDate(value: Date, name: string): string {
  if (!Number.isFinite(value.getTime())) throw new Error(`raw runtime lifecycle ${name} is invalid`);
  return value.toISOString();
}

function assertIsoDate(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || new Date(value).toISOString() !== value) {
    throw new Error(`raw runtime owner marker ${name} is invalid`);
  }
}

function assertPlainObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`raw runtime owner marker ${name} is invalid`);
  }
}

function assertKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`raw runtime owner marker ${name} has unexpected fields`);
  }
}

function assertIdentity(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/u.test(value)) {
    throw new Error(`raw runtime lifecycle ${name} is invalid`);
  }
}

function assertProcessStartIdentity(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`raw runtime owner marker ${name} is invalid`);
  }
}

function assertProcessFields(value: Record<string, unknown>, name: string): void {
  const hasPgid = Object.hasOwn(value, 'pgid');
  const hasStart = Object.hasOwn(value, 'processStartIdentity');
  if (hasPgid !== hasStart) {
    throw new Error(`raw runtime owner marker ${name} process identity is incomplete`);
  }
  if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) {
    throw new Error(`raw runtime owner marker ${name} pid is invalid`);
  }
  if (!hasPgid) return;
  if (!Number.isSafeInteger(value.pgid) || (value.pgid as number) <= 0) {
    throw new Error(`raw runtime owner marker ${name} pgid is invalid`);
  }
  assertProcessStartIdentity(value.processStartIdentity, `${name} processStartIdentity`);
}

function assertOwner(value: unknown): asserts value is RawRuntimeOwnerIdentity {
  assertPlainObject(value, 'owner');
  const hasProcessIdentity = Object.hasOwn(value, 'pgid')
    || Object.hasOwn(value, 'processStartIdentity');
  assertKeys(
    value,
    hasProcessIdentity
      ? ['pid', 'instanceId', 'startedAt', 'pgid', 'processStartIdentity']
      : ['pid', 'instanceId', 'startedAt'],
    'owner',
  );
  assertProcessFields(value, 'owner');
  assertIdentity(value.instanceId, 'owner instanceId');
  assertIsoDate(value.startedAt, 'owner startedAt');
}

function assertDaemon(value: unknown): asserts value is RawRuntimeDaemonIdentity {
  assertPlainObject(value, 'daemon');
  const hasProcessIdentity = Object.hasOwn(value, 'pgid')
    || Object.hasOwn(value, 'processStartIdentity');
  assertKeys(
    value,
    hasProcessIdentity ? ['pid', 'pgid', 'processStartIdentity'] : ['pid'],
    'daemon',
  );
  assertProcessFields(value, 'daemon');
}

function parseMarker(value: unknown): RuntimeOwnerMarker {
  assertPlainObject(value, 'root');
  const hasQuarantine = Object.hasOwn(value, 'quarantine');
  const hasDaemon = Object.hasOwn(value, 'daemon');
  assertKeys(
    value,
    [
      'schemaVersion', 'identity', 'state', 'createdAt', 'creation', 'owner',
      ...(hasDaemon ? ['daemon'] : []),
      ...(hasQuarantine ? ['quarantine'] : []),
    ],
    'root',
  );
  if (value.schemaVersion !== lifecycleSchemaVersion) {
    throw new Error('raw runtime owner marker schemaVersion is unsupported');
  }
  assertIdentity(value.identity, 'identity');
  if (value.state !== 'staging' && value.state !== 'quarantine') {
    throw new Error('raw runtime owner marker state is invalid');
  }
  assertIsoDate(value.createdAt, 'createdAt');
  assertPlainObject(value.creation, 'creation');
  assertKeys(value.creation, ['device', 'inode'], 'creation');
  if (typeof value.creation.device !== 'string' || !/^\d+$/u.test(value.creation.device)
    || typeof value.creation.inode !== 'string' || !/^\d+$/u.test(value.creation.inode)) {
    throw new Error('raw runtime owner marker creation identity is invalid');
  }
  assertOwner(value.owner);
  if (hasDaemon) assertDaemon(value.daemon);
  if (value.state === 'staging' && hasQuarantine) {
    throw new Error('raw runtime staging marker must not contain quarantine metadata');
  }
  if (value.state === 'quarantine') {
    assertPlainObject(value.quarantine, 'quarantine');
    assertKeys(
      value.quarantine,
      ['reason', 'quarantinedAt', 'treeDigest', 'bytes', 'fileCount'],
      'quarantine',
    );
    if (!['startup-failure', 'functional-failure', 'forced-shard-kill'].includes(
      value.quarantine.reason as string,
    )) throw new Error('raw runtime owner marker quarantine reason is invalid');
    assertIsoDate(value.quarantine.quarantinedAt, 'quarantinedAt');
    if (typeof value.quarantine.treeDigest !== 'string'
      || !/^sha256:[a-f0-9]{64}$/u.test(value.quarantine.treeDigest)
      || !Number.isSafeInteger(value.quarantine.bytes) || (value.quarantine.bytes as number) < 0
      || !Number.isSafeInteger(value.quarantine.fileCount) || (value.quarantine.fileCount as number) < 0) {
      throw new Error('raw runtime owner marker quarantine snapshot is invalid');
    }
  }
  return value as unknown as RuntimeOwnerMarker;
}

function processStartIdentity(source: string): string {
  return `sha256:${createHash('sha256').update(source, 'utf8').digest('hex')}`;
}

function processPresence(pid: number): 'alive' | 'dead' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    return 'unknown';
  }
}

async function probeLinuxProcessIdentity(pid: number): Promise<RawRuntimeProcessProbe> {
  try {
    const statLine = await readFile(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = statLine.lastIndexOf(')');
    if (commandEnd < 0) return { status: 'unknown' };
    const fields = statLine.slice(commandEnd + 1).trim().split(/\s+/u);
    const pgid = Number(fields[2]);
    const startedAtTicks = fields[19];
    if (!Number.isSafeInteger(pgid) || pgid <= 0 || !/^\d+$/u.test(startedAtTicks ?? '')) {
      return { status: 'unknown' };
    }
    return {
      status: 'alive',
      identity: {
        pid,
        pgid,
        processStartIdentity: processStartIdentity(`linux-proc-stat:${pid}:${startedAtTicks}`),
      },
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' && processPresence(pid) === 'dead') return { status: 'dead' };
    return { status: 'unknown' };
  }
}

async function probeDarwinProcessIdentity(pid: number): Promise<RawRuntimeProcessProbe> {
  const presence = processPresence(pid);
  if (presence !== 'alive') return { status: presence };
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        '/bin/ps',
        ['-p', String(pid), '-o', 'pid=', '-o', 'pgid=', '-o', 'lstart='],
        { encoding: 'utf8', env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' } },
        (error, output) => {
          if (error) reject(error);
          else resolve(output);
        },
      );
    });
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(stdout);
    if (!match || Number(match[1]) !== pid) return { status: 'unknown' };
    const pgid = Number(match[2]);
    if (!Number.isSafeInteger(pgid) || pgid <= 0) return { status: 'unknown' };
    return {
      status: 'alive',
      identity: {
        pid,
        pgid,
        processStartIdentity: processStartIdentity(`darwin-ps:${pid}:${match[3]}`),
      },
    };
  } catch {
    return processPresence(pid) === 'dead' ? { status: 'dead' } : { status: 'unknown' };
  }
}

async function defaultProcessIdentityProbe(pid: number): Promise<RawRuntimeProcessProbe> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: 'unknown' };
  const presence = processPresence(pid);
  if (presence !== 'alive') return { status: presence };
  if (process.platform === 'linux') return probeLinuxProcessIdentity(pid);
  if (process.platform === 'darwin') return probeDarwinProcessIdentity(pid);
  return { status: 'unknown' };
}

function currentUid(): bigint | undefined {
  const uid = process.getuid?.();
  return uid === undefined ? undefined : BigInt(uid);
}

function stableStat(value: BigIntStats): StableStat {
  return {
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mtimeNs: value.mtimeNs,
    mode: value.mode,
    uid: value.uid,
    nlink: value.nlink,
  };
}

function sameStableStat(left: StableStat, right: StableStat): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.mode === right.mode
    && left.uid === right.uid
    && left.nlink === right.nlink;
}

function assertOwned(value: BigIntStats, role: string): void {
  const uid = currentUid();
  if (uid !== undefined && value.uid !== uid) throw new Error(`raw runtime ${role} has another owner`);
}

function assertPrivateRoot(value: BigIntStats, role: string): void {
  if (!value.isDirectory() || value.isSymbolicLink()) {
    throw new Error(`raw runtime ${role} must be a physical directory`);
  }
  assertOwned(value, role);
  if ((value.mode & 0o777n) !== 0o700n) throw new Error(`raw runtime ${role} must use mode 0700`);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureStorageRoot(input: string): Promise<string> {
  const storageRoot = path.resolve(input);
  try {
    await mkdir(storageRoot, { mode: 0o700 });
    await chmod(storageRoot, 0o700);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const metadata = await lstat(storageRoot, { bigint: true });
  assertPrivateRoot(metadata, 'storage root');
  // macOS exposes /var through the system /private/var alias. Reject a
  // symlink at the configured root itself, then keep the physical path so all
  // descendant containment checks use one stable spelling.
  return realpath(storageRoot);
}

function serializeMarker(marker: RuntimeOwnerMarker): Buffer {
  return Buffer.from(`${JSON.stringify(marker, null, 2)}\n`, 'utf8');
}

async function writeInitialMarker(root: string, marker: RuntimeOwnerMarker): Promise<void> {
  const handle = await open(path.join(root, markerName), 'wx', 0o600);
  try {
    await handle.writeFile(serializeMarker(marker));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(root);
}

async function replaceMarker(root: string, marker: RuntimeOwnerMarker): Promise<void> {
  const temporary = path.join(root, `.runtime-owner.tmp-${randomUUID()}`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(serializeMarker(marker));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path.join(root, markerName));
    await syncDirectory(root);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function readMarker(root: string): Promise<{ marker: RuntimeOwnerMarker; bytes: number }> {
  const markerPath = path.join(root, markerName);
  const handle = await open(markerPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
      throw new Error('raw runtime owner marker must be a physical single-link file');
    }
    assertOwned(before, 'owner marker');
    if ((before.mode & 0o777n) !== 0o600n || before.size > 64n * 1024n) {
      throw new Error('raw runtime owner marker is not bounded and private');
    }
    const contents = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameStableStat(stableStat(before), stableStat(after))) {
      throw new Error('raw runtime owner marker changed while reading');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents.toString('utf8')) as unknown;
    } catch {
      throw new Error('raw runtime owner marker is malformed');
    }
    return { marker: parseMarker(parsed), bytes: contents.byteLength };
  } finally {
    await handle.close();
  }
}

function framed(hash: ReturnType<typeof createHash>, value: string): void {
  const encoded = Buffer.from(value, 'utf8');
  const size = Buffer.allocUnsafe(4);
  size.writeUInt32BE(encoded.byteLength);
  hash.update(size);
  hash.update(encoded);
}

function relativeLabel(relative: string): string {
  return relative.split(path.sep).join('/');
}

function resolvedSnapshotLimits(
  input: Partial<typeof defaultSnapshotLimits> | undefined,
): typeof defaultSnapshotLimits {
  const limits = { ...defaultSnapshotLimits, ...input };
  positiveSafeInteger(limits.maxFiles, 'maxFiles');
  positiveSafeInteger(limits.maxBytes, 'maxBytes');
  positiveSafeInteger(limits.chunkBytes, 'chunkBytes');
  if (limits.chunkBytes > 1024 * 1024) {
    throw new Error('raw runtime lifecycle chunkBytes must not exceed 1048576');
  }
  return limits;
}

async function snapshotRuntimeTree(
  root: string,
  inputLimits?: Partial<typeof defaultSnapshotLimits>,
  options?: { allowControlledDaemonSocket?: boolean },
): Promise<RuntimeTreeSnapshot> {
  const limits = resolvedSnapshotLimits(inputLimits);
  const rootMetadata = await lstat(root, { bigint: true });
  assertPrivateRoot(rootMetadata, 'root');
  const hash = createHash('sha256');
  framed(hash, 'mimi-conversation-raw-runtime-tree-v2');
  let bytes = 0;
  let fileCount = 0;

  const visit = async (absolute: string, relative: string): Promise<void> => {
    const before = await lstat(absolute, { bigint: true });
    assertOwned(before, `entry ${relativeLabel(relative)}`);
    if (before.isSymbolicLink()) {
      throw new Error('raw runtime content contains a symbolic link');
    }
    if (before.isDirectory()) {
      const beforeNames = (await readdir(absolute)).sort();
      framed(hash, 'directory');
      framed(hash, relativeLabel(relative));
      framed(hash, (before.mode & 0o7777n).toString(8));
      for (const name of beforeNames) {
        if (relative === '' && name === markerName) continue;
        await visit(path.join(absolute, name), path.join(relative, name));
      }
      const afterNames = (await readdir(absolute)).sort();
      const after = await lstat(absolute, { bigint: true });
      if (!sameStableStat(stableStat(before), stableStat(after))
        || beforeNames.length !== afterNames.length
        || beforeNames.some((name, index) => name !== afterNames[index])) {
        throw new Error('raw runtime content changed during snapshot');
      }
      return;
    }
    if (options?.allowControlledDaemonSocket
      && relativeLabel(relative) === 'daemon/mimi.sock'
      && before.isSocket()) {
      fileCount += 1;
      if (fileCount > limits.maxFiles) throw new Error('raw runtime content file quota exceeded');
      framed(hash, 'unix-socket');
      framed(hash, relativeLabel(relative));
      framed(hash, (before.mode & 0o7777n).toString(8));
      const after = await lstat(absolute, { bigint: true });
      if (!sameStableStat(stableStat(before), stableStat(after))) {
        throw new Error('raw runtime controlled socket changed during snapshot');
      }
      return;
    }
    if (!before.isFile() || before.nlink !== 1n) {
      throw new Error('raw runtime content contains a special or hard-linked file');
    }
    fileCount += 1;
    if (fileCount > limits.maxFiles) throw new Error('raw runtime content file quota exceeded');
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('raw runtime content byte quota exceeded');
    }
    const fileBytes = Number(before.size);
    if (fileBytes > limits.maxBytes - bytes) throw new Error('raw runtime content byte quota exceeded');
    const handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const openedBefore = await handle.stat({ bigint: true });
      if (!openedBefore.isFile() || openedBefore.nlink !== 1n
        || !sameStableStat(stableStat(before), stableStat(openedBefore))) {
        throw new Error('raw runtime content changed before reading');
      }
      const fileHash = createHash('sha256');
      const chunk = Buffer.allocUnsafe(limits.chunkBytes);
      let readBytes = 0;
      while (true) {
        const result = await handle.read(chunk, 0, chunk.byteLength, null);
        if (result.bytesRead === 0) break;
        fileHash.update(chunk.subarray(0, result.bytesRead));
        readBytes += result.bytesRead;
      }
      const openedAfter = await handle.stat({ bigint: true });
      if (readBytes !== fileBytes
        || !sameStableStat(stableStat(openedBefore), stableStat(openedAfter))) {
        throw new Error('raw runtime content changed while reading');
      }
      bytes += fileBytes;
      framed(hash, 'file');
      framed(hash, relativeLabel(relative));
      framed(hash, (openedBefore.mode & 0o7777n).toString(8));
      framed(hash, String(fileBytes));
      framed(hash, fileHash.digest('hex'));
    } finally {
      await handle.close();
    }
  };

  await visit(root, '');
  const afterRoot = await lstat(root, { bigint: true });
  if (!sameStableStat(stableStat(rootMetadata), stableStat(afterRoot))) {
    throw new Error('raw runtime root changed during snapshot');
  }
  return { treeDigest: `sha256:${hash.digest('hex')}`, bytes, fileCount };
}

function rootCreationIdentity(metadata: BigIntStats): RootCreationIdentity {
  return { device: metadata.dev.toString(), inode: metadata.ino.toString() };
}

function sameCreationIdentity(left: RootCreationIdentity, right: RootCreationIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function handleMarker(handle: ControlledRawRuntime): RuntimeOwnerMarker {
  return {
    schemaVersion: lifecycleSchemaVersion,
    identity: handle.identity,
    state: 'staging',
    createdAt: handle.createdAt,
    creation: handle.creation,
    owner: handle.owner,
    ...(handle.daemon ? { daemon: handle.daemon } : {}),
  };
}

async function validateHandle(handle: ControlledRawRuntime): Promise<RuntimeOwnerMarker> {
  const storageRoot = await ensureStorageRoot(handle.storageRoot);
  const root = path.resolve(handle.root);
  const relative = path.relative(storageRoot, root);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)
    || !path.basename(root).startsWith(stagingPrefix)) {
    throw new Error('raw runtime handle root is outside controlled staging storage');
  }
  const metadata = await lstat(root, { bigint: true });
  assertPrivateRoot(metadata, 'root');
  const creation = rootCreationIdentity(metadata);
  if (!sameCreationIdentity(creation, handle.creation)) {
    throw new Error('raw runtime handle root creation identity changed');
  }
  const { marker } = await readMarker(root);
  if (JSON.stringify(marker) !== JSON.stringify(handleMarker(handle))) {
    throw new Error('raw runtime handle does not own its staging root');
  }
  return marker;
}

function sameProcessIdentity(
  recorded: { pid: number; pgid?: number; processStartIdentity?: string },
  actual: RawRuntimeProcessIdentity,
): boolean {
  return recorded.pid === actual.pid
    && recorded.pgid === actual.pgid
    && recorded.processStartIdentity === actual.processStartIdentity;
}

async function recordedProcessLiveness(
  recorded: { pid: number; pgid?: number; processStartIdentity?: string },
  probe: (pid: number) => RawRuntimeProcessProbe | Promise<RawRuntimeProcessProbe>,
): Promise<'live' | 'dead' | 'unknown'> {
  const actual = await probe(recorded.pid);
  if (actual.status !== 'alive') return actual.status === 'dead' ? 'dead' : 'unknown';
  if (recorded.pgid === undefined || recorded.processStartIdentity === undefined) return 'unknown';
  return sameProcessIdentity(recorded, actual.identity) ? 'live' : 'dead';
}

async function markerProcessLiveness(
  marker: RuntimeOwnerMarker,
  options: Pick<RuntimeRecoveryOptions, 'ownerIsLive' | 'processIdentityProbe'>,
): Promise<'live' | 'dead' | 'unknown'> {
  const probe = options.processIdentityProbe ?? defaultProcessIdentityProbe;
  const ownerLiveness = options.ownerIsLive
    ? (await options.ownerIsLive(marker.owner) ? 'live' : 'dead')
    : await recordedProcessLiveness(marker.owner, probe);
  const daemonLiveness = marker.daemon
    ? await recordedProcessLiveness(marker.daemon, probe)
    : 'dead';
  if (ownerLiveness === 'live' || daemonLiveness === 'live') return 'live';
  if (ownerLiveness === 'unknown' || daemonLiveness === 'unknown') return 'unknown';
  return 'dead';
}

async function removeControlledDaemonSocket(root: string): Promise<void> {
  const daemonRoot = path.join(root, 'daemon');
  const socket = path.join(daemonRoot, 'mimi.sock');
  let metadata: BigIntStats;
  try {
    metadata = await lstat(socket, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  assertOwned(metadata, 'controlled daemon socket');
  if (!metadata.isSocket() || metadata.isSymbolicLink()) {
    throw new Error('raw runtime controlled daemon socket is not a Unix socket');
  }
  await rm(socket);
  await syncDirectory(daemonRoot);
}

async function prepareBoundDaemonForCleanup(runtime: ControlledRawRuntime): Promise<void> {
  if (!runtime.daemon) return;
  const liveness = await recordedProcessLiveness(runtime.daemon, defaultProcessIdentityProbe);
  if (liveness !== 'dead') {
    throw new Error(`raw runtime bound Daemon process liveness is ${liveness}; cleanup refused`);
  }
  await removeControlledDaemonSocket(runtime.root);
}

export async function createControlledRawRuntime(
  options: CreateControlledRawRuntimeOptions,
): Promise<ControlledRawRuntime> {
  const storageRoot = await ensureStorageRoot(options.storageRoot);
  const root = await mkdtemp(path.join(storageRoot, stagingPrefix));
  try {
    await chmod(root, 0o700);
    const metadata = await lstat(root, { bigint: true });
    assertPrivateRoot(metadata, 'root');
    const identity = (options.identityFactory ?? randomUUID)();
    assertIdentity(identity, 'identity');
    const createdAt = validDate((options.now ?? (() => new Date()))(), 'createdAt');
    let owner = options.owner;
    if (!owner) {
      const probed = await defaultProcessIdentityProbe(process.pid);
      owner = {
        pid: process.pid,
        instanceId: processInstanceId,
        startedAt: processStartedAt,
        ...(probed.status === 'alive'
          ? {
            pgid: probed.identity.pgid,
            processStartIdentity: probed.identity.processStartIdentity,
          }
          : {}),
      };
    }
    assertOwner(owner);
    const handle: ControlledRawRuntime = {
      root,
      storageRoot,
      identity,
      createdAt,
      creation: rootCreationIdentity(metadata),
      owner,
    };
    await writeInitialMarker(root, handleMarker(handle));
    await syncDirectory(storageRoot);
    return handle;
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function bindControlledRawRuntimeDaemon(
  runtime: ControlledRawRuntime,
  daemonPid: number,
): Promise<RawRuntimeDaemonIdentity> {
  positiveSafeInteger(daemonPid, 'daemon pid');
  const marker = await validateHandle(runtime);
  if (runtime.daemon && runtime.daemon.pid !== daemonPid) {
    throw new Error('raw runtime already belongs to another Daemon process');
  }
  if (!runtime.daemon) {
    const pending: RawRuntimeDaemonIdentity = { pid: daemonPid };
    await replaceMarker(runtime.root, { ...marker, daemon: pending });
    runtime.daemon = pending;
  }
  const probed = await defaultProcessIdentityProbe(daemonPid);
  if (probed.status !== 'alive') {
    throw new Error(`raw runtime Daemon process identity is ${probed.status}`);
  }
  const daemon: RawRuntimeDaemonIdentity = {
    pid: daemonPid,
    pgid: probed.identity.pgid,
    processStartIdentity: probed.identity.processStartIdentity,
  };
  const current = await readMarker(runtime.root);
  await replaceMarker(runtime.root, { ...current.marker, daemon });
  runtime.daemon = daemon;
  const verified = await defaultProcessIdentityProbe(daemonPid);
  if (verified.status !== 'alive' || !sameProcessIdentity(daemon, verified.identity)) {
    throw new Error('raw runtime Daemon process identity changed while binding');
  }
  return daemon;
}

export async function setupControlledRawRuntime<T>(
  options: CreateControlledRawRuntimeOptions,
  setup: (runtime: ControlledRawRuntime) => Promise<T>,
): Promise<{ runtime: ControlledRawRuntime; value: T }> {
  const runtime = await createControlledRawRuntime(options);
  try {
    return { runtime, value: await setup(runtime) };
  } catch (setupError) {
    try {
      await discardControlledRawRuntime(runtime);
    } catch (cleanupError) {
      throw new AggregateError(
        [setupError, cleanupError],
        'raw runtime setup failed and controlled cleanup could not complete',
      );
    }
    throw setupError;
  }
}

export async function discardControlledRawRuntime(runtime: ControlledRawRuntime): Promise<void> {
  await validateHandle(runtime);
  await prepareBoundDaemonForCleanup(runtime);
  await snapshotRuntimeTree(runtime.root);
  const before = stableStat(await lstat(runtime.root, { bigint: true }));
  if (!sameCreationIdentity(runtime.creation, {
    device: before.dev.toString(),
    inode: before.ino.toString(),
  })) throw new Error('raw runtime root changed before cleanup');
  await rm(runtime.root, { recursive: true });
  await syncDirectory(runtime.storageRoot);
}

export async function finalizeControlledRawRuntime(
  runtime: ControlledRawRuntime,
  retention?: { reason: RawRuntimeRetentionReason; now?: () => Date },
): Promise<RawRuntimeFinalization> {
  const marker = await validateHandle(runtime);
  await prepareBoundDaemonForCleanup(runtime);
  if (!retention) {
    await rm(runtime.root, { recursive: true });
    await syncDirectory(runtime.storageRoot);
    return { state: 'deleted', rawRuntimeDeleted: true };
  }
  const snapshot = await snapshotRuntimeTree(runtime.root);
  const quarantinedAt = validDate((retention.now ?? (() => new Date()))(), 'quarantinedAt');
  const quarantine: RuntimeQuarantineMetadata = {
    ...snapshot,
    reason: retention.reason,
    quarantinedAt,
  };
  await replaceMarker(runtime.root, { ...marker, state: 'quarantine', quarantine });
  const quarantineRoot = path.join(runtime.storageRoot, `${quarantinePrefix}${runtime.identity}`);
  await rename(runtime.root, quarantineRoot);
  await chmod(quarantineRoot, 0o700);
  await syncDirectory(runtime.storageRoot);
  return {
    state: 'quarantined',
    rawRuntimeDeleted: false,
    quarantineId: runtime.identity,
    ...snapshot,
    createdAt: runtime.createdAt,
    quarantinedAt,
    reason: retention.reason,
  };
}

function millisecondsSince(now: Date, value: string): number {
  return Math.max(0, now.getTime() - new Date(value).getTime());
}

async function preflightCandidate(
  storageRoot: string,
  name: string,
  options: RuntimeRecoveryOptions,
  now: Date,
): Promise<RecoveryCandidate> {
  const root = path.join(storageRoot, name);
  const metadata = await lstat(root, { bigint: true });
  assertPrivateRoot(metadata, 'recovery candidate');
  const kind = name.startsWith(quarantinePrefix) ? 'quarantine' : 'staging';
  let marker: RuntimeOwnerMarker | undefined;
  let markerBytes = 0;
  try {
    const read = await readMarker(root);
    marker = read.marker;
    markerBytes = read.bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || kind === 'quarantine') throw error;
  }
  if (marker) {
    if (!sameCreationIdentity(marker.creation, rootCreationIdentity(metadata))) {
      throw new Error('raw runtime recovery candidate creation identity changed');
    }
    if (kind === 'quarantine' && marker.state !== 'quarantine') {
      throw new Error('raw runtime quarantine candidate has a staging marker');
    }
  }
  const liveness = marker ? await markerProcessLiveness(marker, options) : 'dead';
  const snapshot = await snapshotRuntimeTree(root, options.snapshotLimits, {
    allowControlledDaemonSocket: marker?.daemon !== undefined,
  });
  const reference = marker?.quarantine?.quarantinedAt
    ?? marker?.createdAt
    ?? new Date(Number(metadata.mtimeMs)).toISOString();
  const grace = marker?.state === 'quarantine' || kind === 'quarantine'
    ? options.quarantineGraceMs
    : options.stagingGraceMs;
  return {
    root,
    kind: marker?.state === 'quarantine' ? 'quarantine' : kind,
    marker,
    markerBytes,
    snapshot,
    rootStat: stableStat(metadata),
    liveness,
    expired: millisecondsSince(now, reference) >= grace,
  };
}

function sameSnapshot(left: RuntimeTreeSnapshot, right: RuntimeTreeSnapshot): boolean {
  return left.treeDigest === right.treeDigest
    && left.bytes === right.bytes
    && left.fileCount === right.fileCount;
}

export async function recoverControlledRawRuntimes(
  options: RuntimeRecoveryOptions,
): Promise<RuntimeRecoveryReport> {
  positiveSafeInteger(options.stagingGraceMs, 'stagingGraceMs');
  positiveSafeInteger(options.quarantineGraceMs, 'quarantineGraceMs');
  positiveSafeInteger(options.quotaBytes, 'quotaBytes');
  const storageRoot = await ensureStorageRoot(options.storageRoot);
  const now = (options.now ?? (() => new Date()))();
  validDate(now, 'recovery time');
  const names = (await readdir(storageRoot)).filter((name) => (
    name.startsWith(stagingPrefix) || name.startsWith(quarantinePrefix)
  )).sort();
  const candidates: RecoveryCandidate[] = [];
  for (const name of names) candidates.push(await preflightCandidate(storageRoot, name, options, now));
  const potentiallyRemovable = candidates.filter((candidate) => (
    candidate.liveness === 'dead' && candidate.expired
  ));
  const removable: RecoveryCandidate[] = [];

  // A second stable pass protects all-or-nothing fail-closed recovery: no root
  // is removed if another candidate changed after the first inventory.
  for (const candidate of potentiallyRemovable) {
    const currentStat = stableStat(await lstat(candidate.root, { bigint: true }));
    if (!sameStableStat(candidate.rootStat, currentStat)) {
      throw new Error('raw runtime recovery candidate changed before cleanup');
    }
    const liveness = candidate.marker
      ? await markerProcessLiveness(candidate.marker, options)
      : 'dead';
    if (liveness !== 'dead') {
      candidate.liveness = liveness;
      continue;
    }
    const current = await snapshotRuntimeTree(candidate.root, options.snapshotLimits, {
      allowControlledDaemonSocket: candidate.marker?.daemon !== undefined,
    });
    if (!sameSnapshot(candidate.snapshot, current)) {
      throw new Error('raw runtime recovery candidate content changed before cleanup');
    }
    removable.push(candidate);
  }

  let reclaimedBytes = 0;
  let removedStagingRoots = 0;
  let removedQuarantineRoots = 0;
  for (const candidate of removable) {
    if (candidate.marker?.daemon) {
      await removeControlledDaemonSocket(candidate.root);
      await snapshotRuntimeTree(candidate.root, options.snapshotLimits);
    }
    reclaimedBytes += candidate.snapshot.bytes + candidate.markerBytes;
    if (candidate.kind === 'quarantine') removedQuarantineRoots += 1;
    else removedStagingRoots += 1;
    await rm(candidate.root, { recursive: true });
  }
  if (removable.length > 0) await syncDirectory(storageRoot);
  const retained = candidates.filter((candidate) => !removable.includes(candidate));
  const usedBytes = retained.reduce(
    (total, candidate) => total + candidate.snapshot.bytes + candidate.markerBytes,
    0,
  );
  return {
    schemaVersion: lifecycleSchemaVersion,
    scannedRoots: candidates.length,
    preservedLiveRoots: retained.filter((candidate) => candidate.liveness === 'live').length,
    preservedUnknownRoots: retained.filter((candidate) => candidate.liveness === 'unknown').length,
    preservedYoungRoots: retained.filter((candidate) => (
      candidate.liveness === 'dead' && !candidate.expired
    )).length,
    removedStagingRoots,
    removedQuarantineRoots,
    reclaimedBytes,
    usedBytes,
    quotaBytes: options.quotaBytes,
    quotaExceeded: usedBytes > options.quotaBytes,
  };
}

function alreadyExited(child: ExitObservableProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export async function waitForProcessExitWithDeadline(
  child: ExitObservableProcess,
  timeoutMs: number,
): Promise<boolean> {
  positiveSafeInteger(timeoutMs, 'process exit timeoutMs');
  if (alreadyExited(child)) return true;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(value);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(alreadyExited(child)), timeoutMs);
    child.once('exit', onExit);
    if (alreadyExited(child)) finish(true);
  });
}

function signalProcessGroup(child: ExitObservableProcess, signal: NodeJS.Signals): void {
  if (child.pid && child.pid > 1) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The child may not be a process-group leader; use the direct handle.
    }
  }
  child.kill(signal);
}

export async function terminateProcessWithDeadlines(
  child: ExitObservableProcess,
  options: TerminateProcessOptions,
): Promise<TerminateProcessResult> {
  positiveSafeInteger(options.gracefulWaitMs, 'gracefulWaitMs');
  positiveSafeInteger(options.killWaitMs, 'killWaitMs');
  if (alreadyExited(child)) return { exited: true, forced: false, killTimedOut: false };
  const signal = options.signal ?? signalProcessGroup;
  signal(child, 'SIGTERM');
  if (await waitForProcessExitWithDeadline(child, options.gracefulWaitMs)) {
    return { exited: true, forced: false, killTimedOut: false };
  }
  signal(child, 'SIGKILL');
  const exited = await waitForProcessExitWithDeadline(child, options.killWaitMs);
  return { exited, forced: true, killTimedOut: !exited };
}

export type { ChildProcess };
