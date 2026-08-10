import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  durableReplace,
  durableWriteExclusive,
} from './conversation-durable-io.js';

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const HASH_CHUNK_BYTES = 64 * 1024;
const MAX_CANONICAL_INDEX_BYTES = 16 * 1024 * 1024;

export type EvidenceSealRole =
  | 'canonical-entity'
  | 'canonical-index'
  | 'correction'
  | 'privacy-tombstone'
  | 'terminal-transcript'
  | 'protocol-journal'
  | 'checkpoint'
  | 'scenario-manifest'
  | 'build-log'
  | 'proof'
  | 'benchmark-metadata';

export interface EvidenceSealFile {
  path: string;
  sha256: string;
  bytes: number;
  mode: 0o600;
  role: EvidenceSealRole;
  generation: number;
}

export interface EvidenceSealManifest {
  schemaVersion: 1;
  kind: 'conversation-evidence-seal';
  hashAlgorithm: 'sha256';
  detached: true;
  excludedAttestationPath: string;
  generation: number;
  parentIndexHash: string | null;
  treeDigest: string;
  files: EvidenceSealFile[];
  fileCount: number;
  bytes: number;
}

export interface CreateEvidenceSealOptions {
  generation: number;
  parentIndexHash?: string;
}

export interface VerifyEvidenceSealOptions {
  expectedGeneration?: number;
  expectedParentIndexHash?: string | null;
}

export interface EvidenceSealVerification {
  verified: true;
  attestationSha256: string;
  manifest: EvidenceSealManifest;
}

export type EvidenceErasurePhase =
  | 'overwritten-synced'
  | 'unlinked'
  | 'directory-synced'
  | 'tombstone-written';

export type EvidenceErasureReason = 'privacy-match' | 'forbidden-name' | 'secret-pattern';

export interface EvidenceErasureOptions {
  generation: number;
  reason: EvidenceErasureReason;
  parentIndexHash?: string;
  onPhase?: (phase: EvidenceErasurePhase) => void | Promise<void>;
}

export interface EvidenceErasureTombstone {
  schemaVersion: 1;
  kind: 'conversation-evidence-privacy-tombstone';
  generation: number;
  parentIndexHash: string | null;
  reason: EvidenceErasureReason;
  removedPathSha256: string;
  removedFileSha256: string;
  removedBytes: number;
}

interface StableFileRead {
  bytes: Buffer;
  metadata: Stats;
  sha256: string;
}

interface CanonicalArtifactReference {
  path: string;
  sha256: string;
  bytes: number;
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('evidence seal requires a current uid');
  return uid;
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validGeneration(value: number, label = 'generation'): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function validHash(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (!HASH_PATTERN.test(value)) throw new Error(`${label} must be a lowercase sha256 digest`);
  return value;
}

function canonicalRelativePath(value: string, label: string): string {
  if (value.length === 0 || value.includes('\0') || value.includes('\\') || path.isAbsolute(value)) {
    throw new Error(`${label} must be a normalized relative evidence path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${label} must be a normalized relative evidence path`);
  }
  return normalized;
}

function assertPrivate(metadata: Stats, mode: 0o700 | 0o600, kind: 'root' | 'directory' | 'file', relative: string): void {
  if (metadata.uid !== currentUid() || (metadata.mode & 0o777) !== mode) {
    throw new Error(`evidence ${kind} is not private: ${relative || '.'}`);
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.mode === right.mode
    && left.uid === right.uid
    && left.nlink === right.nlink;
}

function samePhysicalFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.uid === right.uid
    && left.nlink === right.nlink;
}

function assertPhysicalRoot(metadata: Stats): void {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('evidence root must be a physical directory');
  }
  assertPrivate(metadata, 0o700, 'root', '');
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isDirectory()) throw new Error('evidence parent is not a physical directory');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function classifyEvidenceRole(relative: string): EvidenceSealRole {
  const basename = path.posix.basename(relative);
  if (/(?:^|[._-])correction(?:[._-]|$)/iu.test(basename)) return 'correction';
  if (basename.endsWith('.canonical-index.json')) return 'canonical-index';
  if (basename.endsWith('.tombstone.json') || basename === 'privacy-tombstone.json') {
    return 'privacy-tombstone';
  }
  if (relative.startsWith('pty-smoke-canonical/') || relative.startsWith('canonical/')
    || relative.startsWith('turns/')) return 'canonical-entity';
  if (/terminal\.(?:ansi|txt)$/u.test(basename)) return 'terminal-transcript';
  if (basename === 'evidence.jsonl') return 'protocol-journal';
  if (basename === 'checkpoint.json') return 'checkpoint';
  if (basename === 'manifest.json') return 'scenario-manifest';
  if (basename === 'build.log') return 'build-log';
  if (basename.endsWith('.proof.json') || basename === 'proof.json') return 'proof';
  return 'benchmark-metadata';
}

function looksLikeAttestation(relative: string): boolean {
  const basename = path.posix.basename(relative);
  return basename === 'evidence-integrity.json'
    || basename === 'evidence-seal.json'
    || basename.endsWith('.evidence-seal.json')
    || basename.endsWith('.attestation.json');
}

async function assertPrivateAncestors(root: string, relative: string): Promise<void> {
  const components = relative.split('/').slice(0, -1);
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`evidence contains unsupported directory ${path.relative(root, current)}`);
    }
    assertPrivate(metadata, 0o700, 'directory', path.relative(root, current));
  }
}

async function readStableRegularFile(root: string, relativeValue: string, maximumBytes?: number): Promise<StableFileRead> {
  const relative = canonicalRelativePath(relativeValue, 'evidence file path');
  await assertPrivateAncestors(root, relative);
  const absolute = path.join(root, relative);
  const pathMetadata = await lstat(absolute);
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
    throw new Error(`evidence entry is not a physical file: ${relative}`);
  }
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`evidence entry is not a physical file: ${relative}`);
    assertPrivate(before, 0o600, 'file', relative);
    if (before.nlink !== 1) throw new Error(`evidence file has multiple links: ${relative}`);
    if (maximumBytes !== undefined && before.size > maximumBytes) {
      throw new Error(`evidence file exceeds bounded read limit: ${relative}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const finalPathMetadata = await lstat(absolute);
    if (!sameFile(before, after) || !sameFile(after, finalPathMetadata) || bytes.byteLength !== after.size) {
      throw new Error(`evidence file changed while reading: ${relative}`);
    }
    return { bytes, metadata: after, sha256: digest(bytes) };
  } finally {
    await handle.close();
  }
}

async function scanEvidenceTree(
  rootValue: string,
  excludedAttestationPath: string,
  generation: number,
): Promise<EvidenceSealFile[]> {
  const root = path.resolve(rootValue);
  assertPhysicalRoot(await lstat(root));
  const excluded = canonicalRelativePath(excludedAttestationPath, 'attestation path');
  const files: EvidenceSealFile[] = [];

  const visit = async (directory: string, relativeRoot: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => comparePath(left.name, right.name));
    if (relativeRoot && entries.length === 0) {
      throw new Error(`evidence tree contains an empty unindexed directory: ${relativeRoot}`);
    }
    for (const entry of entries) {
      const relative = path.posix.join(relativeRoot, entry.name);
      if (relative === excluded) continue;
      if (looksLikeAttestation(relative)) {
        throw new Error(`evidence tree contains multiple attestation files: ${relative}`);
      }
      const absolute = path.join(directory, entry.name);
      const pathMetadata = await lstat(absolute);
      if (pathMetadata.isDirectory() && !pathMetadata.isSymbolicLink()) {
        assertPrivate(pathMetadata, 0o700, 'directory', relative);
        await visit(absolute, relative);
        continue;
      }
      if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
        throw new Error(`unsupported evidence entry ${relative}`);
      }
      const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (!before.isFile()) throw new Error(`evidence entry is not a physical file: ${relative}`);
        assertPrivate(before, 0o600, 'file', relative);
        if (before.nlink !== 1) throw new Error(`evidence file has multiple links: ${relative}`);
        const hash = createHash('sha256');
        const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
        let offset = 0;
        for (;;) {
          const result = await handle.read(chunk, 0, chunk.byteLength, offset);
          if (result.bytesRead === 0) break;
          hash.update(chunk.subarray(0, result.bytesRead));
          offset += result.bytesRead;
        }
        const after = await handle.stat();
        const finalPathMetadata = await lstat(absolute);
        if (!sameFile(before, after) || !sameFile(after, finalPathMetadata) || offset !== after.size) {
          throw new Error(`evidence file changed while scanning: ${relative}`);
        }
        files.push({
          path: relative,
          sha256: hash.digest('hex'),
          bytes: offset,
          mode: 0o600,
          role: classifyEvidenceRole(relative),
          generation,
        });
      } finally {
        await handle.close();
      }
    }
  };

  await visit(root, '');
  files.sort((left, right) => comparePath(left.path, right.path));
  return files;
}

function artifactReferences(value: unknown, into: CanonicalArtifactReference[] = []): CanonicalArtifactReference[] {
  if (Array.isArray(value)) {
    for (const item of value) artifactReferences(item, into);
    return into;
  }
  if (value === null || typeof value !== 'object') return into;
  const item = value as Record<string, unknown>;
  const resemblesArtifact = typeof item.path === 'string'
    && (Object.hasOwn(item, 'sha256') || Object.hasOwn(item, 'bytes'));
  if (resemblesArtifact) {
    if (typeof item.sha256 !== 'string' || !HASH_PATTERN.test(item.sha256)
      || !Number.isSafeInteger(item.bytes) || (item.bytes as number) < 0) {
      throw new Error(`canonical index contains a malformed artifact reference: ${item.path as string}`);
    }
    into.push({
      path: canonicalRelativePath(item.path as string, 'canonical artifact path'),
      sha256: item.sha256,
      bytes: item.bytes as number,
    });
  }
  for (const nested of Object.values(item)) artifactReferences(nested, into);
  return into;
}

async function validateCanonicalIndexes(
  rootValue: string,
  files: readonly EvidenceSealFile[],
  excludedAttestationPath: string,
): Promise<void> {
  const root = path.resolve(rootValue);
  const fileMap = new Map(files.map((file) => [file.path, file]));
  const referenced = new Set<string>();
  for (const indexEntry of files.filter((file) => file.role === 'canonical-index')) {
    const read = await readStableRegularFile(root, indexEntry.path, MAX_CANONICAL_INDEX_BYTES);
    if (read.sha256 !== indexEntry.sha256 || read.bytes.byteLength !== indexEntry.bytes) {
      throw new Error(`canonical index hash mismatch: ${indexEntry.path}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.bytes.toString('utf8')) as unknown;
    } catch {
      throw new Error(`canonical index is not valid JSON: ${indexEntry.path}`);
    }
    for (const artifact of artifactReferences(parsed)) {
      if (artifact.path === excludedAttestationPath) {
        throw new Error(`canonical index cannot reference detached attestation: ${indexEntry.path}`);
      }
      const sealed = fileMap.get(artifact.path);
      if (!sealed) throw new Error(`canonical index references missing artifact: ${artifact.path}`);
      if (sealed.sha256 !== artifact.sha256 || sealed.bytes !== artifact.bytes) {
        throw new Error(`canonical artifact hash mismatch: ${artifact.path}`);
      }
      referenced.add(artifact.path);
    }
  }
  for (const correction of files.filter((file) => file.role === 'correction')) {
    if (!referenced.has(correction.path)) {
      throw new Error(`unindexed correction artifact ${correction.path}`);
    }
  }
}

function manifestTreeDigest(files: readonly EvidenceSealFile[]): string {
  return digest(JSON.stringify(files));
}

function buildManifest(
  files: EvidenceSealFile[],
  excludedAttestationPath: string,
  generation: number,
  parentIndexHash: string | undefined,
): EvidenceSealManifest {
  return {
    schemaVersion: 1,
    kind: 'conversation-evidence-seal',
    hashAlgorithm: 'sha256',
    detached: true,
    excludedAttestationPath,
    generation,
    parentIndexHash: parentIndexHash ?? null,
    treeDigest: manifestTreeDigest(files),
    files,
    fileCount: files.length,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
  };
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(comparePath);
  const wanted = [...expected].sort(comparePath);
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function parseManifest(value: unknown, expectedAttestationPath: string): EvidenceSealManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('evidence attestation is not an object');
  }
  const item = value as Record<string, unknown>;
  exactKeys(item, [
    'schemaVersion', 'kind', 'hashAlgorithm', 'detached', 'excludedAttestationPath',
    'generation', 'parentIndexHash', 'treeDigest', 'files', 'fileCount', 'bytes',
  ], 'evidence attestation');
  if (item.schemaVersion !== 1 || item.kind !== 'conversation-evidence-seal'
    || item.hashAlgorithm !== 'sha256' || item.detached !== true) {
    throw new Error('evidence attestation header is invalid');
  }
  const generation = validGeneration(item.generation as number);
  const excludedAttestationPath = canonicalRelativePath(
    item.excludedAttestationPath as string,
    'excluded attestation path',
  );
  if (excludedAttestationPath !== expectedAttestationPath) {
    throw new Error('evidence attestation excludes a different file');
  }
  const parentIndexHash = item.parentIndexHash === null
    ? null
    : validHash(item.parentIndexHash as string, 'parentIndexHash');
  if (typeof item.treeDigest !== 'string' || !HASH_PATTERN.test(item.treeDigest)) {
    throw new Error('evidence attestation treeDigest is invalid');
  }
  if (!Array.isArray(item.files)) throw new Error('evidence attestation files must be an array');
  const files = item.files.map((entry, index): EvidenceSealFile => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`evidence attestation file ${index} is invalid`);
    }
    const record = entry as Record<string, unknown>;
    exactKeys(record, ['path', 'sha256', 'bytes', 'mode', 'role', 'generation'], `evidence file ${index}`);
    const relative = canonicalRelativePath(record.path as string, `evidence file ${index} path`);
    if (relative === excludedAttestationPath) throw new Error('detached attestation cannot index itself');
    if (typeof record.sha256 !== 'string' || !HASH_PATTERN.test(record.sha256)) {
      throw new Error(`evidence file ${relative} sha256 is invalid`);
    }
    if (!Number.isSafeInteger(record.bytes) || (record.bytes as number) < 0) {
      throw new Error(`evidence file ${relative} bytes is invalid`);
    }
    if (record.mode !== 0o600) throw new Error(`evidence file ${relative} mode is invalid`);
    const expectedRole = classifyEvidenceRole(relative);
    if (record.role !== expectedRole) throw new Error(`evidence file ${relative} role is inconsistent`);
    if (record.generation !== generation) throw new Error(`evidence file ${relative} generation is inconsistent`);
    return {
      path: relative,
      sha256: record.sha256,
      bytes: record.bytes as number,
      mode: 0o600,
      role: expectedRole,
      generation,
    };
  });
  for (let index = 1; index < files.length; index += 1) {
    if (comparePath(files[index - 1]!.path, files[index]!.path) >= 0) {
      throw new Error('evidence attestation paths are not unique and sorted');
    }
  }
  if (!Number.isSafeInteger(item.fileCount) || item.fileCount !== files.length) {
    throw new Error('evidence attestation fileCount is inconsistent');
  }
  const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
  if (!Number.isSafeInteger(item.bytes) || item.bytes !== totalBytes) {
    throw new Error('evidence attestation bytes is inconsistent');
  }
  if (manifestTreeDigest(files) !== item.treeDigest) {
    throw new Error('evidence attestation treeDigest is inconsistent');
  }
  return {
    schemaVersion: 1,
    kind: 'conversation-evidence-seal',
    hashAlgorithm: 'sha256',
    detached: true,
    excludedAttestationPath,
    generation,
    parentIndexHash: parentIndexHash ?? null,
    treeDigest: item.treeDigest,
    files,
    fileCount: files.length,
    bytes: totalBytes,
  };
}

function mismatchReason(expected: readonly EvidenceSealFile[], actual: readonly EvidenceSealFile[]): string | undefined {
  const expectedMap = new Map(expected.map((entry) => [entry.path, entry]));
  const actualMap = new Map(actual.map((entry) => [entry.path, entry]));
  for (const entry of actual) {
    if (!expectedMap.has(entry.path)) {
      if (entry.role === 'correction') return `unindexed correction artifact ${entry.path}`;
      return `unexpected evidence file ${entry.path}`;
    }
  }
  for (const entry of expected) {
    const found = actualMap.get(entry.path);
    if (!found) return `missing evidence file ${entry.path}`;
    if (JSON.stringify(found) !== JSON.stringify(entry)) {
      return `evidence manifest mismatch for ${entry.path}`;
    }
  }
  return undefined;
}

async function readAttestation(rootValue: string, attestationRelativePath: string): Promise<{
  manifest: EvidenceSealManifest;
  bytes: Buffer;
  sha256: string;
}> {
  const root = path.resolve(rootValue);
  assertPhysicalRoot(await lstat(root));
  const attestation = canonicalRelativePath(attestationRelativePath, 'attestation path');
  const read = await readStableRegularFile(root, attestation, MAX_CANONICAL_INDEX_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error('evidence attestation is not valid JSON');
  }
  return { manifest: parseManifest(parsed, attestation), bytes: read.bytes, sha256: read.sha256 };
}

export async function createEvidenceSeal(
  rootValue: string,
  attestationRelativePath: string,
  options: CreateEvidenceSealOptions,
): Promise<EvidenceSealManifest> {
  const root = path.resolve(rootValue);
  assertPhysicalRoot(await lstat(root));
  const attestation = canonicalRelativePath(attestationRelativePath, 'attestation path');
  const generation = validGeneration(options.generation);
  const parentIndexHash = validHash(options.parentIndexHash, 'parentIndexHash');
  const attestationAbsolute = path.join(root, attestation);
  let replacesExisting = false;
  try {
    await lstat(attestationAbsolute);
    replacesExisting = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (replacesExisting) {
    const previous = await readAttestation(root, attestation);
    if (parentIndexHash !== previous.sha256) {
      throw new Error('parentIndexHash does not match the previous attestation');
    }
    const expectedGeneration = previous.manifest.generation + 1;
    if (generation !== expectedGeneration) {
      throw new Error(`next seal generation must be ${expectedGeneration}`);
    }
  } else if (parentIndexHash !== undefined) {
    throw new Error('parentIndexHash requires an existing attestation');
  }

  const files = await scanEvidenceTree(root, attestation, generation);
  await validateCanonicalIndexes(root, files, attestation);
  const manifest = buildManifest(files, attestation, generation, parentIndexHash);
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (replacesExisting) await durableReplace(attestationAbsolute, serialized);
  else await durableWriteExclusive(attestationAbsolute, serialized);
  await verifyEvidenceSeal(root, attestation, {
    expectedGeneration: generation,
    expectedParentIndexHash: parentIndexHash ?? null,
  });
  return manifest;
}

export async function verifyEvidenceSeal(
  rootValue: string,
  attestationRelativePath: string,
  options: VerifyEvidenceSealOptions = {},
): Promise<EvidenceSealVerification> {
  const root = path.resolve(rootValue);
  const attestation = canonicalRelativePath(attestationRelativePath, 'attestation path');
  const read = await readAttestation(root, attestation);
  if (options.expectedGeneration !== undefined
    && read.manifest.generation !== validGeneration(options.expectedGeneration, 'expectedGeneration')) {
    throw new Error('evidence seal generation does not match the expected generation');
  }
  if (options.expectedParentIndexHash !== undefined) {
    const expected = options.expectedParentIndexHash === null
      ? null
      : validHash(options.expectedParentIndexHash, 'expectedParentIndexHash');
    if (read.manifest.parentIndexHash !== expected) {
      throw new Error('evidence seal parentIndexHash does not match the expected parent');
    }
  }
  const first = await scanEvidenceTree(root, attestation, read.manifest.generation);
  const firstMismatch = mismatchReason(read.manifest.files, first);
  if (firstMismatch) throw new Error(firstMismatch);
  await validateCanonicalIndexes(root, first, attestation);
  const second = await scanEvidenceTree(root, attestation, read.manifest.generation);
  const secondMismatch = mismatchReason(read.manifest.files, second);
  if (secondMismatch) throw new Error(secondMismatch);
  if (manifestTreeDigest(second) !== read.manifest.treeDigest) {
    throw new Error('evidence treeDigest changed during verification');
  }
  return { verified: true, attestationSha256: read.sha256, manifest: read.manifest };
}

export async function eraseOffendingEvidenceFile(
  rootValue: string,
  offendingRelativePath: string,
  tombstoneRelativePath: string,
  options: EvidenceErasureOptions,
): Promise<EvidenceErasureTombstone> {
  const root = path.resolve(rootValue);
  assertPhysicalRoot(await lstat(root));
  const offending = canonicalRelativePath(offendingRelativePath, 'offending evidence path');
  const tombstone = canonicalRelativePath(tombstoneRelativePath, 'privacy tombstone path');
  if (offending === tombstone) throw new Error('privacy tombstone must not replace the offending file');
  await Promise.all([
    assertPrivateAncestors(root, offending),
    assertPrivateAncestors(root, tombstone),
  ]);
  try {
    await lstat(path.join(root, tombstone));
    throw new Error('privacy tombstone destination already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const generation = validGeneration(options.generation);
  const parentIndexHash = validHash(options.parentIndexHash, 'parentIndexHash');
  const absolute = path.join(root, offending);
  const pathMetadata = await lstat(absolute);
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
    throw new Error('privacy erasure requires one physical regular file');
  }
  const handle = await open(absolute, constants.O_RDWR | constants.O_NOFOLLOW);
  let removedFileSha256: string;
  let removedBytes: number;
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('privacy erasure requires one physical regular file');
    assertPrivate(before, 0o600, 'file', offending);
    if (before.nlink !== 1) throw new Error(`evidence file has multiple links: ${offending}`);
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let offset = 0;
    for (;;) {
      const result = await handle.read(chunk, 0, chunk.byteLength, offset);
      if (result.bytesRead === 0) break;
      hash.update(chunk.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    removedFileSha256 = hash.digest('hex');
    removedBytes = offset;
    const zeroes = Buffer.alloc(HASH_CHUNK_BYTES);
    for (let position = 0; position < removedBytes;) {
      const length = Math.min(zeroes.byteLength, removedBytes - position);
      const result = await handle.write(zeroes, 0, length, position);
      if (result.bytesWritten !== length || result.bytesWritten <= 0) {
        throw new Error('privacy erasure could not overwrite the complete file');
      }
      position += result.bytesWritten;
    }
    await handle.sync();
    const overwritten = await handle.stat();
    if (!samePhysicalFile(before, overwritten)) {
      throw new Error('offending evidence changed during privacy erasure');
    }
    await options.onPhase?.('overwritten-synced');
    const currentPathMetadata = await lstat(absolute);
    if (!samePhysicalFile(overwritten, currentPathMetadata)) {
      throw new Error('offending evidence path changed during privacy erasure');
    }
    await unlink(absolute);
    await options.onPhase?.('unlinked');
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(absolute));
  await options.onPhase?.('directory-synced');

  const record: EvidenceErasureTombstone = {
    schemaVersion: 1,
    kind: 'conversation-evidence-privacy-tombstone',
    generation,
    parentIndexHash: parentIndexHash ?? null,
    reason: options.reason,
    removedPathSha256: digest(`conversation-evidence-removed-path-v1\0${offending}`),
    removedFileSha256,
    removedBytes,
  };
  await durableWriteExclusive(path.join(root, tombstone), `${JSON.stringify(record, null, 2)}\n`);
  await options.onPhase?.('tombstone-written');
  return record;
}
