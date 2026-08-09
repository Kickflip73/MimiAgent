import { randomUUID } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
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

export interface EphemeralCredentialFile {
  root: string;
  file: string;
}

interface EphemeralCredentialOptions {
  temporaryRoot?: string;
  excludedRoot?: string;
}

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

function containsPath(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/** Create the real Provider .env outside the retained evidence tree. */
export async function createEphemeralCredentialFile(
  contents: string,
  options: EphemeralCredentialOptions = {},
): Promise<EphemeralCredentialFile> {
  const temporaryRoot = path.resolve(options.temporaryRoot ?? os.tmpdir());
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(path.join(temporaryRoot, 'mimi-conversation-secret-'));
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
    await durableWriteExclusive(credential.file, contents);
    await syncDirectory(temporaryRoot);
    return credential;
  } catch (error) {
    if (credential) await cleanupEphemeralCredentialFile(credential).catch(() => undefined);
    else await rmdir(root).catch(() => undefined);
    throw error;
  }
}

/** Best-effort overwrite plus durable unlink for a normally shutting-down runner. */
export async function cleanupEphemeralCredentialFile(
  credential: EphemeralCredentialFile,
  hooks?: DurableIoHooks,
): Promise<void> {
  const root = path.resolve(credential.root);
  const file = path.resolve(credential.file);
  if (!path.basename(root).startsWith('mimi-conversation-secret-')
    || path.dirname(file) !== root
    || path.basename(file) !== '.env') {
    throw new Error('refusing to clean an invalid ephemeral credential path');
  }
  let fileExists = true;
  try {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error('ephemeral credential is not a regular file');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fileExists = false;
    else throw error;
  }
  if (fileExists) {
    const handle = await open(file, 'r+');
    try {
      const size = (await handle.stat()).size;
      const zeroes = Buffer.alloc(Math.min(64 * 1024, Math.max(1, size)));
      for (let offset = 0; offset < size; offset += zeroes.byteLength) {
        const length = Math.min(zeroes.byteLength, size - offset);
        await handle.write(zeroes, 0, length, offset);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await phase(hooks, 'credential-overwritten');
    await unlink(file);
    await syncDirectory(root);
    await phase(hooks, 'credential-unlinked');
  }
  try {
    await rmdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await syncDirectory(path.dirname(root));
  await phase(hooks, 'secret-root-removed');
}
