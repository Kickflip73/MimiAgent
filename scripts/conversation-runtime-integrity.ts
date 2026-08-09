import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import {
  lstat,
  open,
  readdir,
  readlink,
  realpath,
} from 'node:fs/promises';
import path from 'node:path';

export const runtimeDependencySnapshotSchemaVersion = 1 as const;

export interface RuntimeDependencySnapshot {
  schemaVersion: typeof runtimeDependencySnapshotSchemaVersion;
  digest: string;
  fileCount: number;
  bytes: number;
}

export interface RuntimeDependencySnapshotLimits {
  maxFiles?: number;
  maxBytes?: number;
  chunkBytes?: number;
}

interface ResolvedLimits {
  maxFiles: number;
  maxBytes: number;
  chunkBytes: number;
}

interface StableStat {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  mode: bigint;
}

const defaultLimits: ResolvedLimits = {
  maxFiles: 100_000,
  maxBytes: 2 * 1024 * 1024 * 1024,
  chunkBytes: 64 * 1024,
};

function positiveSafeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`runtime dependency snapshot ${name} must be a positive safe integer`);
  }
  return resolved;
}

function resolveLimits(limits: RuntimeDependencySnapshotLimits | undefined): ResolvedLimits {
  const chunkBytes = positiveSafeInteger(limits?.chunkBytes, defaultLimits.chunkBytes, 'chunkBytes');
  if (chunkBytes > 1024 * 1024) {
    throw new Error('runtime dependency snapshot chunkBytes must not exceed 1048576');
  }
  return {
    maxFiles: positiveSafeInteger(limits?.maxFiles, defaultLimits.maxFiles, 'maxFiles'),
    maxBytes: positiveSafeInteger(limits?.maxBytes, defaultLimits.maxBytes, 'maxBytes'),
    chunkBytes,
  };
}

function framed(hash: ReturnType<typeof createHash>, value: string): void {
  const encoded = Buffer.from(value, 'utf8');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(encoded.length);
  hash.update(length);
  hash.update(encoded);
}

function displayPath(relative: string): string {
  return relative.length === 0 ? '.' : relative;
}

function permissions(mode: bigint): string {
  return (mode & 0o7777n).toString(8).padStart(4, '0');
}

function stableStat(stat: BigIntStats): StableStat {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    mode: stat.mode,
  };
}

function sameStableStat(left: StableStat, right: StableStat): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.mode === right.mode;
}

function insideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function entryNames(entries: Array<{ name: string }>): string[] {
  return entries.map((entry) => entry.name).sort();
}

function sameNames(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Snapshot the actual dependency tree used by a calibration runtime. The root
 * itself may be a symlink, but every symlink below it must be relative and stay
 * inside the resolved root. Symlink targets are recorded, never followed.
 */
export async function snapshotRuntimeDependencyTree(
  nodeModulesRoot: string,
  limits?: RuntimeDependencySnapshotLimits,
): Promise<RuntimeDependencySnapshot> {
  const resolvedLimits = resolveLimits(limits);
  let root: string;
  try {
    root = await realpath(nodeModulesRoot);
  } catch {
    throw new Error('runtime dependency root is unavailable');
  }

  const rootStat = await lstat(root, { bigint: true });
  if (!rootStat.isDirectory()) throw new Error('runtime dependency root is not a directory');

  const hash = createHash('sha256');
  framed(hash, `mimi-runtime-dependency-tree-v${runtimeDependencySnapshotSchemaVersion}`);
  let fileCount = 0;
  let bytes = 0;

  const countFile = (relative: string): void => {
    fileCount += 1;
    if (fileCount > resolvedLimits.maxFiles) {
      throw new Error(`runtime dependency file limit exceeded at ${displayPath(relative)}`);
    }
  };

  const visit = async (absolute: string, relative: string): Promise<void> => {
    const before = await lstat(absolute, { bigint: true });
    const relativeLabel = relative.split(path.sep).join('/');

    if (before.isDirectory()) {
      framed(hash, 'directory');
      framed(hash, relativeLabel);
      framed(hash, permissions(before.mode));
      const beforeNames = entryNames(await readdir(absolute, { withFileTypes: true }));
      for (const name of beforeNames) {
        await visit(path.join(absolute, name), relative.length === 0 ? name : path.join(relative, name));
      }
      const afterNames = entryNames(await readdir(absolute, { withFileTypes: true }));
      const after = await lstat(absolute, { bigint: true });
      if (!after.isDirectory()
        || !sameStableStat(stableStat(before), stableStat(after))
        || !sameNames(beforeNames, afterNames)) {
        throw new Error(`runtime dependency directory changed during traversal at ${displayPath(relativeLabel)}`);
      }
      return;
    }

    if (before.isSymbolicLink()) {
      countFile(relativeLabel);
      const target = await readlink(absolute);
      if (path.isAbsolute(target)) {
        throw new Error(`runtime dependency symlink must be relative at ${displayPath(relativeLabel)}`);
      }
      const resolvedTarget = path.resolve(path.dirname(absolute), target);
      if (!insideRoot(root, resolvedTarget)) {
        throw new Error(`runtime dependency symlink escapes root at ${displayPath(relativeLabel)}`);
      }
      let physicalTarget: string;
      try {
        physicalTarget = await realpath(absolute);
      } catch {
        throw new Error(`runtime dependency symlink target is unavailable at ${displayPath(relativeLabel)}`);
      }
      if (!insideRoot(root, physicalTarget)) {
        throw new Error(`runtime dependency symlink escapes root at ${displayPath(relativeLabel)}`);
      }
      const after = await lstat(absolute, { bigint: true });
      const afterTarget = await readlink(absolute);
      if (!after.isSymbolicLink()
        || !sameStableStat(stableStat(before), stableStat(after))
        || target !== afterTarget) {
        throw new Error(`runtime dependency symlink changed during traversal at ${displayPath(relativeLabel)}`);
      }
      framed(hash, 'symlink');
      framed(hash, relativeLabel);
      framed(hash, permissions(before.mode));
      framed(hash, target.split(path.sep).join('/'));
      return;
    }

    if (!before.isFile()) {
      throw new Error(`runtime dependency special file is not allowed at ${displayPath(relativeLabel)}`);
    }

    countFile(relativeLabel);
    const handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const openedBefore = await handle.stat({ bigint: true });
      if (!openedBefore.isFile() || !sameStableStat(stableStat(before), stableStat(openedBefore))) {
        throw new Error(`runtime dependency file changed before reading at ${displayPath(relativeLabel)}`);
      }
      if (openedBefore.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`runtime dependency byte limit exceeded at ${displayPath(relativeLabel)}`);
      }
      const fileBytes = Number(openedBefore.size);
      if (fileBytes > resolvedLimits.maxBytes - bytes) {
        throw new Error(`runtime dependency byte limit exceeded at ${displayPath(relativeLabel)}`);
      }

      const fileHash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(resolvedLimits.chunkBytes);
      let readBytes = 0;
      while (true) {
        const result = await handle.read(buffer, 0, buffer.length, null);
        if (result.bytesRead === 0) break;
        fileHash.update(buffer.subarray(0, result.bytesRead));
        readBytes += result.bytesRead;
      }
      const openedAfter = await handle.stat({ bigint: true });
      if (readBytes !== fileBytes
        || !sameStableStat(stableStat(openedBefore), stableStat(openedAfter))) {
        throw new Error(`runtime dependency file changed while reading at ${displayPath(relativeLabel)}`);
      }
      bytes += fileBytes;
      framed(hash, 'file');
      framed(hash, relativeLabel);
      framed(hash, permissions(openedBefore.mode));
      framed(hash, String(fileBytes));
      framed(hash, fileHash.digest('hex'));
    } finally {
      await handle.close();
    }
  };

  await visit(root, '');
  return {
    schemaVersion: runtimeDependencySnapshotSchemaVersion,
    digest: `sha256:${hash.digest('hex')}`,
    fileCount,
    bytes,
  };
}

export function compareRuntimeDependencySnapshots(
  expected: RuntimeDependencySnapshot,
  actual: RuntimeDependencySnapshot,
): boolean {
  return expected.schemaVersion === actual.schemaVersion
    && expected.digest === actual.digest
    && expected.fileCount === actual.fileCount
    && expected.bytes === actual.bytes;
}

export function assertRuntimeDependencySnapshot(
  expected: RuntimeDependencySnapshot,
  actual: RuntimeDependencySnapshot,
): void {
  if (!compareRuntimeDependencySnapshots(expected, actual)) {
    throw new Error('runtime dependency snapshot changed');
  }
}
