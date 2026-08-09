import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type DurableIoPhase =
  | 'temporary-synced'
  | 'published'
  | 'append-written'
  | 'append-synced'
  | 'directory-synced'
  | 'credential-overwritten'
  | 'credential-unlinked'
  | 'secret-root-removed';

export interface DurableIoHooks {
  onPhase?: (phase: DurableIoPhase) => void | Promise<void>;
}

export interface CheckpointVersion {
  generation: number;
  sequence: number;
}

export interface EphemeralCredentialFile {
  root: string;
  file: string;
}

export interface EphemeralCredentialRecoveryResult {
  scanned: number;
  recovered: number;
  preserved: number;
}

interface EphemeralCredentialOptions {
  temporaryRoot?: string;
  excludedRoot?: string;
}

interface EphemeralCredentialRecoveryOptions {
  temporaryRoot?: string;
  graceMs?: number;
  now?: number;
}

interface CredentialOwner {
  schemaVersion: 1;
  pid: number;
  processStartIdentity: string;
  createdAt: number;
  token: string;
}

const SECRET_ROOT_PREFIX = 'mimi-conversation-secret-';
const SECRET_ROOT_NAME = /^mimi-conversation-secret-[A-Za-z0-9]{6}$/u;
const CREDENTIAL_OWNER_FILE = '.owner';
const UNKNOWN_OWNER_GRACE_MS = 60 * 60 * 1_000;

function bytes(value: string | Buffer): Buffer {
  return typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
}

async function phase(hooks: DurableIoHooks | undefined, value: DurableIoPhase): Promise<void> {
  await hooks?.onPhase?.(value);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureParent(file: string): Promise<string> {
  const parent = path.dirname(file);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  return parent;
}

function temporaryFile(file: string): string {
  return path.join(
    path.dirname(file),
    `.${path.basename(file)}.tmp-${process.pid}-${randomUUID()}`,
  );
}

async function writeSyncedTemporary(
  file: string,
  value: string | Buffer,
  hooks?: DurableIoHooks,
): Promise<string> {
  await ensureParent(file);
  const temporary = temporaryFile(file);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes(value));
    await handle.chmod(0o600);
    await handle.sync();
    await phase(hooks, 'temporary-synced');
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return temporary;
}

/** Publish a new 0600 file without ever exposing a partially-written destination. */
export async function durableWriteExclusive(
  file: string,
  value: string | Buffer,
  hooks?: DurableIoHooks,
): Promise<void> {
  const parent = await ensureParent(file);
  const temporary = await writeSyncedTemporary(file, value, hooks);
  try {
    try {
      // A same-directory hard link is an atomic no-clobber publish. rename(2)
      // would silently replace an existing proof artifact on POSIX.
      await link(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`durable destination already exists: ${file}`);
      }
      throw error;
    }
    await phase(hooks, 'published');
    await unlink(temporary);
    await syncDirectory(parent);
    await phase(hooks, 'directory-synced');
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

/** Atomically replace a mutable 0600 checkpoint after its temporary file is durable. */
export async function durableReplace(
  file: string,
  value: string | Buffer,
  hooks?: DurableIoHooks,
): Promise<void> {
  const parent = await ensureParent(file);
  const temporary = await writeSyncedTemporary(file, value, hooks);
  try {
    await rename(temporary, file);
    await phase(hooks, 'published');
    await syncDirectory(parent);
    await phase(hooks, 'directory-synced');
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

/**
 * Append one already-delimited journal record and make both the bytes and its
 * directory entry durable before returning to a caller that may dispatch work.
 */
export async function durableAppend(
  file: string,
  value: string | Buffer,
  hooks?: DurableIoHooks,
): Promise<void> {
  const parent = await ensureParent(file);
  const handle = await open(file, 'a', 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(bytes(value));
    await phase(hooks, 'append-written');
    await handle.sync();
    await phase(hooks, 'append-synced');
  } finally {
    await handle.close();
  }
  await syncDirectory(parent);
  await phase(hooks, 'directory-synced');
}

function durableFailure(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Single-writer journal boundary. The first durability failure permanently
 * poisons the writer so later records and Provider dispatches cannot continue
 * on evidence that was never proven durable.
 */
export class DurableJournalWriter {
  readonly #file: string;
  readonly #hooks: DurableIoHooks | undefined;
  #tail: Promise<void> = Promise.resolve();
  #poisoned: Error | undefined;

  constructor(file: string, hooks?: DurableIoHooks) {
    this.#file = file;
    this.#hooks = hooks;
  }

  append(value: string | Buffer, hooks = this.#hooks): Promise<void> {
    if (this.#poisoned) return Promise.reject(this.#poisoned);
    const operation = this.#tail.then(async () => {
      if (this.#poisoned) throw this.#poisoned;
      try {
        await durableAppend(this.#file, value, hooks);
      } catch (error) {
        this.#poisoned = durableFailure(error);
        throw this.#poisoned;
      }
    });
    // Deliberately retain the rejected promise. Recovering the queue with a
    // catch would allow later dispatches to cross a failed durability barrier.
    this.#tail = operation;
    return operation;
  }

  async dispatchBarrier<T>(dispatch: () => T | Promise<T>): Promise<T> {
    await this.#tail;
    if (this.#poisoned) throw this.#poisoned;
    return dispatch();
  }
}

interface CheckpointFileState {
  highestReserved: CheckpointVersion | undefined;
  lockTail: Promise<void>;
}

const checkpointStates = new Map<string, CheckpointFileState>();

function checkpointState(file: string): CheckpointFileState {
  const key = path.resolve(file);
  const current = checkpointStates.get(key);
  if (current) return current;
  const created: CheckpointFileState = {
    highestReserved: undefined,
    lockTail: Promise.resolve(),
  };
  checkpointStates.set(key, created);
  return created;
}

function validateCheckpointVersion(version: CheckpointVersion): CheckpointVersion {
  if (!Number.isSafeInteger(version.generation) || version.generation < 0
    || !Number.isSafeInteger(version.sequence) || version.sequence < 0) {
    throw new Error('checkpoint generation and sequence must be non-negative safe integers');
  }
  return { generation: version.generation, sequence: version.sequence };
}

function compareCheckpointVersion(left: CheckpointVersion, right: CheckpointVersion): number {
  if (left.generation !== right.generation) return left.generation - right.generation;
  return left.sequence - right.sequence;
}

async function withCheckpointLock<T>(
  state: CheckpointFileState,
  operation: () => T | Promise<T>,
): Promise<T> {
  const previous = state.lockTail;
  let release!: () => void;
  state.lockTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function staleCheckpointVersion(version: CheckpointVersion): Error {
  return new Error(
    `stale checkpoint version ${version.generation}:${version.sequence}`,
  );
}

/**
 * Atomically publishes only the newest explicitly-versioned checkpoint.
 * Temporary files may be prepared concurrently, but reservation and publish
 * are serialized per destination so a delayed old writer cannot replace a
 * newer snapshot.
 */
export class MonotonicCheckpointWriter {
  readonly #file: string;
  readonly #hooks: DurableIoHooks | undefined;
  readonly #state: CheckpointFileState;

  constructor(file: string, hooks?: DurableIoHooks) {
    this.#file = path.resolve(file);
    this.#hooks = hooks;
    this.#state = checkpointState(this.#file);
  }

  async write(
    requestedVersion: CheckpointVersion,
    value: string | Buffer,
    hooks = this.#hooks,
  ): Promise<void> {
    const version = validateCheckpointVersion(requestedVersion);
    await withCheckpointLock(this.#state, () => {
      const highest = this.#state.highestReserved;
      if (highest && compareCheckpointVersion(version, highest) <= 0) {
        throw staleCheckpointVersion(version);
      }
      this.#state.highestReserved = version;
    });

    const parent = await ensureParent(this.#file);
    const temporary = await writeSyncedTemporary(this.#file, value, hooks);
    try {
      await withCheckpointLock(this.#state, async () => {
        const highest = this.#state.highestReserved;
        if (!highest || compareCheckpointVersion(version, highest) !== 0) {
          throw staleCheckpointVersion(version);
        }
        await rename(temporary, this.#file);
        await phase(hooks, 'published');
        await syncDirectory(parent);
        await phase(hooks, 'directory-synced');
      });
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}

function containsPath(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function execFileOutput(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 4_096,
      env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin', TZ: 'UTC' },
    },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
  });
}

async function readLinuxProcessStartIdentity(pid: number): Promise<string> {
  const statLine = await readFile(`/proc/${pid}/stat`, 'utf8');
  const commandEnd = statLine.lastIndexOf(')');
  if (commandEnd < 0) throw new Error('invalid process stat record');
  // The suffix starts at field 3 (state); starttime is field 22.
  const fields = statLine.slice(commandEnd + 1).trim().split(/\s+/u);
  const startTime = fields[19];
  if (!startTime || !/^\d+$/u.test(startTime)) {
    throw new Error('invalid process start identity');
  }
  return `linux-proc:${startTime}`;
}

async function readProcessStartIdentity(pid: number): Promise<string> {
  if (process.platform === 'linux') return readLinuxProcessStartIdentity(pid);
  const output = await execFileOutput('/bin/ps', ['-p', String(pid), '-o', 'lstart=']);
  const start = output.trim().replace(/\s+/gu, ' ');
  if (!start || start.length > 128 || /[\u0000-\u001f\u007f]/u.test(start)) {
    throw new Error('invalid process start identity');
  }
  return `${process.platform}-ps:${start}`;
}

type ProcessOwnerState =
  | { state: 'dead' }
  | { state: 'unknown' }
  | { state: 'live'; processStartIdentity: string };

async function inspectProcessOwner(pid: number): Promise<ProcessOwnerState> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return { state: 'dead' };
    return { state: 'unknown' };
  }
  try {
    return { state: 'live', processStartIdentity: await readProcessStartIdentity(pid) };
  } catch {
    // A process that disappears between kill(2) and identity lookup is dead;
    // every other lookup failure remains unknown and is protected by grace.
    try {
      process.kill(pid, 0);
      return { state: 'unknown' };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH'
        ? { state: 'dead' }
        : { state: 'unknown' };
    }
  }
}

function parseCredentialOwner(value: string): CredentialOwner | undefined {
  try {
    const input = JSON.parse(value) as unknown;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
    const record = input as Record<string, unknown>;
    if (Object.keys(record).sort().join(',')
      !== 'createdAt,pid,processStartIdentity,schemaVersion,token') return undefined;
    if (record.schemaVersion !== 1
      || !Number.isSafeInteger(record.pid) || (record.pid as number) < 1
      || !Number.isSafeInteger(record.createdAt) || (record.createdAt as number) < 0
      || typeof record.processStartIdentity !== 'string'
      || record.processStartIdentity.length < 1
      || record.processStartIdentity.length > 256
      || /[\u0000-\u001f\u007f]/u.test(record.processStartIdentity)
      || typeof record.token !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
        .test(record.token)) return undefined;
    return record as unknown as CredentialOwner;
  } catch {
    return undefined;
  }
}

async function readRegularFileNoFollow(file: string, maximumBytes: number): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximumBytes) {
      throw new Error('credential metadata is not a bounded regular file');
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function writeCredentialOwner(root: string): Promise<void> {
  const owner: CredentialOwner = {
    schemaVersion: 1,
    pid: process.pid,
    processStartIdentity: await readProcessStartIdentity(process.pid),
    createdAt: Date.now(),
    token: randomUUID(),
  };
  const file = path.join(root, CREDENTIAL_OWNER_FILE);
  const handle = await open(
    file,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`);
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(root);
}

async function validateCredentialRoot(root: string): Promise<string> {
  const resolved = path.resolve(root);
  if (!SECRET_ROOT_NAME.test(path.basename(resolved))) {
    throw new Error('refusing to access an invalid ephemeral credential root');
  }
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('ephemeral credential root is not a real directory');
  }
  if ((metadata.mode & 0o777) !== 0o700
    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
    throw new Error('ephemeral credential root ownership or permissions are invalid');
  }
  const canonical = await realpath(resolved);
  if (canonical !== resolved) {
    throw new Error('ephemeral credential root must use its canonical path');
  }
  return canonical;
}

async function overwriteAndUnlinkCredential(
  file: string,
  onOverwritten?: () => void | Promise<void>,
): Promise<boolean> {
  let handle;
  try {
    handle = await open(file, constants.O_RDWR | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1
      || (metadata.mode & 0o777) !== 0o600
      || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
      throw new Error('ephemeral credential is not a private single-link file');
    }
    const zeroes = Buffer.alloc(Math.min(64 * 1024, Math.max(1, metadata.size)));
    for (let offset = 0; offset < metadata.size; offset += zeroes.byteLength) {
      const length = Math.min(zeroes.byteLength, metadata.size - offset);
      await handle.write(zeroes, 0, length, offset);
    }
    await handle.sync();
    const current = await lstat(file);
    if (!current.isFile() || current.isSymbolicLink()
      || current.dev !== metadata.dev || current.ino !== metadata.ino
      || current.nlink !== 1) {
      throw new Error('ephemeral credential changed during cleanup');
    }
  } finally {
    await handle.close();
  }
  await onOverwritten?.();
  await unlink(file);
  return true;
}

async function unlinkOwnerFile(root: string): Promise<void> {
  const ownerFile = path.join(root, CREDENTIAL_OWNER_FILE);
  let metadata;
  try {
    metadata = await lstat(ownerFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || (metadata.mode & 0o777) !== 0o600
    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
    throw new Error('ephemeral credential owner is not a regular file');
  }
  await unlink(ownerFile);
  await syncDirectory(root);
}

/** Create the real Provider .env outside the retained evidence tree. */
export async function createEphemeralCredentialFile(
  contents: string,
  options: EphemeralCredentialOptions = {},
): Promise<EphemeralCredentialFile> {
  const requestedTemporaryRoot = path.resolve(options.temporaryRoot ?? os.tmpdir());
  await mkdir(requestedTemporaryRoot, { recursive: true, mode: 0o700 });
  const temporaryRoot = await realpath(requestedTemporaryRoot);
  const root = await mkdtemp(path.join(temporaryRoot, SECRET_ROOT_PREFIX));
  await chmod(root, 0o700);
  let credential: EphemeralCredentialFile | undefined;
  try {
    const canonicalRoot = await realpath(root);
    credential = { root: canonicalRoot, file: path.join(canonicalRoot, '.env') };
    if (options.excludedRoot) {
      const canonicalExcluded = await realpath(options.excludedRoot);
      if (containsPath(canonicalExcluded, canonicalRoot)) {
        throw new Error('Provider credential root must stay outside retained evidence');
      }
    }
    // This non-sensitive, synced owner identity must exist before secret bytes
    // so startup recovery can distinguish a dead process from a reused PID.
    await writeCredentialOwner(canonicalRoot);
    await syncDirectory(temporaryRoot);
    await durableWriteExclusive(credential.file, contents);
    await syncDirectory(temporaryRoot);
    return credential;
  } catch (error) {
    if (credential) await cleanupEphemeralCredentialFile(credential).catch(() => undefined);
    else await rmdir(root).catch(() => undefined);
    throw error;
  }
}

/**
 * Recover Provider credential roots abandoned by SIGKILL. Only direct,
 * canonical children of the controlled temporary root are considered.
 */
export async function recoverEphemeralCredentialFiles(
  options: EphemeralCredentialRecoveryOptions = {},
): Promise<EphemeralCredentialRecoveryResult> {
  const requestedRoot = path.resolve(options.temporaryRoot ?? os.tmpdir());
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  const requestedMetadata = await lstat(requestedRoot);
  if (!requestedMetadata.isDirectory() || requestedMetadata.isSymbolicLink()) {
    throw new Error('credential recovery root must be a real directory');
  }
  const temporaryRoot = await realpath(requestedRoot);
  const graceMs = options.graceMs ?? UNKNOWN_OWNER_GRACE_MS;
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) {
    throw new Error('credential recovery grace must be a non-negative safe integer');
  }
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error('credential recovery time must be a non-negative safe integer');
  }
  const result: EphemeralCredentialRecoveryResult = { scanned: 0, recovered: 0, preserved: 0 };
  for (const entry of await readdir(temporaryRoot, { withFileTypes: true })) {
    if (!SECRET_ROOT_NAME.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = path.join(temporaryRoot, entry.name);
    result.scanned += 1;
    let root: string;
    let metadata;
    try {
      root = await validateCredentialRoot(candidate);
      metadata = await lstat(root);
    } catch {
      result.preserved += 1;
      continue;
    }
    let owner: CredentialOwner | undefined;
    try {
      owner = parseCredentialOwner(await readRegularFileNoFollow(
        path.join(root, CREDENTIAL_OWNER_FILE),
        4_096,
      ));
    } catch {
      owner = undefined;
    }
    const age = Math.max(0, now - (owner?.createdAt ?? metadata.mtimeMs));
    let recover = false;
    if (!owner) {
      recover = age >= graceMs;
    } else {
      const processOwner = await inspectProcessOwner(owner.pid);
      if (processOwner.state === 'dead') recover = true;
      else if (processOwner.state === 'live') {
        recover = processOwner.processStartIdentity !== owner.processStartIdentity;
      }
    }
    if (!recover) {
      result.preserved += 1;
      continue;
    }
    try {
      await cleanupEphemeralCredentialFile({ root, file: path.join(root, '.env') });
      result.recovered += 1;
    } catch {
      // A symlink, type change, or concurrent mutation is never followed or
      // force-removed. Leave it for a later, safe reconciliation pass.
      result.preserved += 1;
    }
  }
  return result;
}

/** Best-effort overwrite plus durable unlink for a normally shutting-down runner. */
export async function cleanupEphemeralCredentialFile(
  credential: EphemeralCredentialFile,
  hooks?: DurableIoHooks,
): Promise<void> {
  const root = await validateCredentialRoot(credential.root);
  const file = path.resolve(credential.file);
  if (path.dirname(file) !== root
    || path.basename(file) !== '.env') {
    throw new Error('refusing to clean an invalid ephemeral credential path');
  }
  if (await overwriteAndUnlinkCredential(file, () => phase(hooks, 'credential-overwritten'))) {
    await syncDirectory(root);
    await phase(hooks, 'credential-unlinked');
  }
  await unlinkOwnerFile(root);
  try {
    await rmdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await syncDirectory(path.dirname(root));
  await phase(hooks, 'secret-root-removed');
}
