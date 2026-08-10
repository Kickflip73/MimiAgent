import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rmdir,
} from 'node:fs/promises';
import path from 'node:path';
import { durableWriteExclusive } from './conversation-durable-io.js';
import {
  RetainedEvidencePrivacyError,
  scanRetainedEvidenceTree,
  type PrivateEvidenceNeedle,
  type RetainedEvidenceScan,
} from './conversation-evidence-integrity.js';
import {
  classifyEvidenceRole,
  createEvidenceSeal,
  eraseOffendingEvidenceFile,
  verifyEvidenceSeal,
  type EvidenceErasureReason,
  type EvidenceSealManifest,
} from './conversation-evidence-seal.js';

const outcomeFileName = 'evidence-outcome.json';
const attestationFileName = 'evidence-integrity.json';
const revocationFileName = 'evidence-revocation.json';
const rootMarkerFileName = '.conversation-evidence-root.json';
const privacyTombstoneDirectory = 'privacy-tombstones';
const maximumPrivacyFailures = 1_024;

const privateNeedleKinds = [
  'provider-secret',
  'private-home',
  'credential-root',
  'credential-file',
  'runtime-root',
] as const;
const privacyFailureKinds = [...privateNeedleKinds, 'forbidden-name', 'secret-pattern'] as const;
const evidenceRoles = [
  'canonical-entity',
  'canonical-index',
  'correction',
  'privacy-tombstone',
  'terminal-transcript',
  'protocol-journal',
  'checkpoint',
  'scenario-manifest',
  'build-log',
  'proof',
  'benchmark-metadata',
] as const;

const finalizerOwnedSerializationCorpus = [
  outcomeFileName,
  attestationFileName,
  revocationFileName,
  rootMarkerFileName,
  privacyTombstoneDirectory,
  JSON.stringify({
    schemaVersion: 1,
    kind: 'conversation-evidence-root',
    token: '00000000-0000-0000-0000-000000000000',
    device: '0',
    inode: '0',
  }, null, 2),
  JSON.stringify({
    schemaVersion: 1,
    kind: 'conversation-evidence-revocation',
    proofEligible: false,
    privacyKind: privacyFailureKinds,
    pathHash: '0'.repeat(64),
  }, null, 2),
  JSON.stringify({
    schemaVersion: 1,
    kind: 'conversation-evidence-outcome',
    manifestDigest: '0'.repeat(64),
    buildDigest: '0'.repeat(64),
    proofEligible: false,
    generatedAt: '0000-00-00T00:00:00.000Z',
    checkedNeedleKinds: privateNeedleKinds,
    privacyFailures: privacyFailureKinds.map((kind) => ({ kind, pathHash: '0'.repeat(64) })),
  }, null, 2),
  JSON.stringify({
    schemaVersion: 1,
    kind: 'conversation-evidence-privacy-tombstone',
    generation: 0,
    parentIndexHash: null,
    reason: ['privacy-match', 'forbidden-name', 'secret-pattern'],
    removedPathSha256: '0'.repeat(64),
    removedFileSha256: '0'.repeat(64),
    removedBytes: 0,
  }, null, 2),
  JSON.stringify({
    schemaVersion: 1,
    kind: 'conversation-evidence-seal',
    hashAlgorithm: 'sha256',
    detached: true,
    excludedAttestationPath: attestationFileName,
    generation: 0,
    parentIndexHash: null,
    treeDigest: '0'.repeat(64),
    files: evidenceRoles.map((role) => ({
      path: 'evidence.json', sha256: '0'.repeat(64), bytes: 0, mode: 0o600, role, generation: 0,
    })),
    fileCount: 0,
    bytes: 0,
  }, null, 2),
].map((value) => Buffer.from(`${value}\n`, 'utf8'));

export interface ConversationEvidenceOutcome {
  schemaVersion: 1;
  kind: 'conversation-evidence-outcome';
  manifestDigest: string;
  buildDigest: string;
  proofEligible: boolean;
  generatedAt: string;
  checkedNeedleKinds: RetainedEvidenceScan['checkedNeedleKinds'];
  privacyFailures: Array<{
    kind: RetainedEvidencePrivacyError['kind'];
    pathHash: string;
  }>;
}

export interface FinalizeConversationEvidenceOptions {
  root: ConversationEvidenceRoot;
  privateEvidenceNeedles: readonly PrivateEvidenceNeedle[];
  manifestDigest: string;
  buildDigest: string;
  proofEligible: boolean;
  generation?: number;
  now?: () => Date;
}

export interface FinalizedConversationEvidence {
  outcome: ConversationEvidenceOutcome;
  seal: EvidenceSealManifest;
  attestationSha256: string;
}

export interface ConversationEvidenceRoot {
  root: string;
  token: string;
  device: string;
  inode: string;
}

interface ConversationEvidenceRootMarker {
  schemaVersion: 1;
  kind: 'conversation-evidence-root';
  token: string;
  device: string;
  inode: string;
}

interface EvidenceRevocation {
  schemaVersion: 1;
  kind: 'conversation-evidence-revocation';
  proofEligible: false;
  privacyKind: RetainedEvidencePrivacyError['kind'];
  pathHash: string;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validDigest(value: string, label: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} must be a lowercase sha256 digest`);
  return value;
}

function assertNoFinalizerSerializationCollision(
  options: FinalizeConversationEvidenceOptions,
  generatedAt: string,
): void {
  const dynamicSerialization = Buffer.from(`${JSON.stringify({
    rootMarker: {
      schemaVersion: 1,
      kind: 'conversation-evidence-root',
      token: options.root.token,
      device: options.root.device,
      inode: options.root.inode,
    },
    outcome: {
      schemaVersion: 1,
      kind: 'conversation-evidence-outcome',
      manifestDigest: options.manifestDigest,
      buildDigest: options.buildDigest,
      proofEligible: options.proofEligible,
      generatedAt,
      checkedNeedleKinds: options.privateEvidenceNeedles.map(({ kind }) => kind),
      privacyFailures: [],
    },
  }, null, 2)}\n`, 'utf8');
  const corpus = [...finalizerOwnedSerializationCorpus, dynamicSerialization];
  for (const needle of options.privateEvidenceNeedles) {
    const bytes = Buffer.isBuffer(needle.value)
      ? Buffer.from(needle.value)
      : Buffer.from(needle.value, 'utf8');
    if (corpus.some((serialized) => serialized.includes(bytes))) {
      throw new Error('private evidence needle collides with finalizer-owned serialized metadata');
    }
  }
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('evidence finalization requires a current uid');
  return uid;
}

function validRootToken(value: string): string {
  if (!/^[0-9a-f-]{36}$/u.test(value)) throw new Error('evidence root token is invalid');
  return value;
}

async function validatePhysicalPrivateRoot(rootValue: string): Promise<{
  root: string;
  device: string;
  inode: string;
}> {
  const root = await realpath(path.resolve(rootValue));
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('evidence finalization root must be a physical directory');
  }
  if (metadata.uid !== currentUid() || (metadata.mode & 0o777) !== 0o700) {
    throw new Error('evidence finalization root must be private and owned by the current user');
  }
  return { root, device: String(metadata.dev), inode: String(metadata.ino) };
}

export async function initializeConversationEvidenceRoot(rootValue: string): Promise<ConversationEvidenceRoot> {
  const identity = await validatePhysicalPrivateRoot(rootValue);
  const token = randomUUID();
  const marker: ConversationEvidenceRootMarker = {
    schemaVersion: 1,
    kind: 'conversation-evidence-root',
    token,
    device: identity.device,
    inode: identity.inode,
  };
  await durableWriteExclusive(
    path.join(identity.root, rootMarkerFileName),
    `${JSON.stringify(marker, null, 2)}\n`,
  );
  return { ...identity, token };
}

async function validateEvidenceRoot(handle: ConversationEvidenceRoot): Promise<string> {
  validRootToken(handle.token);
  const identity = await validatePhysicalPrivateRoot(handle.root);
  if (identity.device !== handle.device || identity.inode !== handle.inode) {
    throw new Error('evidence finalization root identity changed');
  }
  const markerBytes = await readFile(path.join(identity.root, rootMarkerFileName));
  let marker: unknown;
  try {
    marker = JSON.parse(markerBytes.toString('utf8')) as unknown;
  } catch {
    throw new Error('evidence root marker is malformed');
  }
  const expected: ConversationEvidenceRootMarker = {
    schemaVersion: 1,
    kind: 'conversation-evidence-root',
    token: handle.token,
    device: handle.device,
    inode: handle.inode,
  };
  if (JSON.stringify(marker) !== JSON.stringify(expected)) {
    throw new Error('evidence root marker does not match the active run');
  }
  return identity.root;
}

function canonicalRelativePath(value: string): string {
  if (!value || value.includes('\0') || value.includes('\\') || path.isAbsolute(value)) {
    throw new Error('privacy failure path is not a normalized relative evidence path');
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('privacy failure path is not a normalized relative evidence path');
  }
  return normalized;
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

async function listPhysicalFiles(root: string, relativeRoot = ''): Promise<string[]> {
  const directory = path.join(root, relativeRoot);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files: string[] = [];
  for (const entry of entries) {
    const relative = path.posix.join(relativeRoot, entry.name);
    const absolute = path.join(root, relative);
    const metadata = await lstat(absolute);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      files.push(...await listPhysicalFiles(root, relative));
      continue;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`cannot sanitize unsupported evidence entry ${relative}`);
    }
    files.push(relative);
  }
  return files;
}

function erasureReason(kind: RetainedEvidencePrivacyError['kind']): EvidenceErasureReason {
  if (kind === 'forbidden-name') return 'forbidden-name';
  if (kind === 'secret-pattern') return 'secret-pattern';
  return 'privacy-match';
}

function tombstonePath(relative: string, ordinal: number): string {
  return path.posix.join(
    privacyTombstoneDirectory,
    `${digest(`conversation-evidence-tombstone-v1\0${relative}`)}-${ordinal}.tombstone.json`,
  );
}

async function eraseOne(
  root: string,
  relativeValue: string,
  ordinal: number,
  reason: EvidenceErasureReason,
): Promise<void> {
  const relative = canonicalRelativePath(relativeValue);
  await mkdir(path.join(root, privacyTombstoneDirectory), { recursive: true, mode: 0o700 });
  await eraseOffendingEvidenceFile(root, relative, tombstonePath(relative, ordinal), {
    generation: 0,
    reason,
  });
}

async function eraseSubtree(
  root: string,
  relativeValue: string,
  ordinal: { value: number },
  reason: EvidenceErasureReason,
): Promise<void> {
  const relative = canonicalRelativePath(relativeValue);
  const absolute = path.join(root, relative);
  const metadata = await lstat(absolute);
  if (metadata.isFile() && !metadata.isSymbolicLink()) {
    await eraseOne(root, relative, ordinal.value, reason);
    ordinal.value += 1;
    return;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`cannot sanitize unsupported evidence entry ${relative}`);
  }
  const files = (await listPhysicalFiles(root, relative)).sort().reverse();
  for (const file of files) {
    await eraseOne(root, file, ordinal.value, reason);
    ordinal.value += 1;
  }
  const directories = [relative];
  const collectDirectories = async (current: string): Promise<void> => {
    const entries = await readdir(path.join(root, current), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const child = path.posix.join(current, entry.name);
      directories.push(child);
      await collectDirectories(child);
    }
  };
  await collectDirectories(relative);
  directories.sort((left, right) => right.split('/').length - left.split('/').length);
  for (const directory of directories) {
    const parent = path.dirname(path.join(root, directory));
    await rmdir(path.join(root, directory));
    await syncDirectory(parent);
  }
}

async function revokeStaleProofArtifacts(root: string, ordinal: { value: number }): Promise<void> {
  const files = await listPhysicalFiles(root);
  const stale = files.filter((relative) => {
    const role = classifyEvidenceRole(relative);
    return role === 'proof' || role === 'canonical-index' || role === 'correction';
  });
  for (const relative of stale) {
    await eraseOne(root, relative, ordinal.value, 'privacy-match');
    ordinal.value += 1;
  }
}

async function pathExists(file: string): Promise<boolean> {
  return lstat(file).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

async function writePrivacyRevocation(
  root: string,
  error: RetainedEvidencePrivacyError,
): Promise<void> {
  const relative = canonicalRelativePath(error.evidencePath);
  const revocation: EvidenceRevocation = {
    schemaVersion: 1,
    kind: 'conversation-evidence-revocation',
    proofEligible: false,
    privacyKind: error.kind,
    pathHash: digest(`conversation-evidence-private-path-v1\0${relative}`),
  };
  await durableWriteExclusive(
    path.join(root, revocationFileName),
    `${JSON.stringify(revocation, null, 2)}\n`,
  );
}

async function sanitizePrivacyFailures(
  root: string,
  privateEvidenceNeedles: readonly PrivateEvidenceNeedle[],
): Promise<{
  privacyFailures: ConversationEvidenceOutcome['privacyFailures'];
  checkedNeedleKinds: RetainedEvidenceScan['checkedNeedleKinds'];
}> {
  const failures: ConversationEvidenceOutcome['privacyFailures'] = [];
  const ordinal = { value: 0 };
  let revoked = false;
  let finalScan: RetainedEvidenceScan | undefined;
  for (;;) {
    try {
      finalScan = await scanRetainedEvidenceTree(root, privateEvidenceNeedles);
      break;
    } catch (error) {
      if (!(error instanceof RetainedEvidencePrivacyError)) throw error;
      if (failures.length >= maximumPrivacyFailures) {
        throw new Error('retained evidence contains too many privacy failures to sanitize safely');
      }
      const relative = canonicalRelativePath(error.evidencePath);
      if (!revoked) {
        await writePrivacyRevocation(root, error);
        revoked = true;
        await revokeStaleProofArtifacts(root, ordinal);
      }
      failures.push({
        kind: error.kind,
        pathHash: digest(`conversation-evidence-private-path-v1\0${relative}`),
      });
      if (await pathExists(path.join(root, relative))) {
        await eraseSubtree(root, relative, ordinal, erasureReason(error.kind));
      }
    }
  }
  if (!finalScan) throw new Error('retained evidence privacy scan did not produce a result');
  return { privacyFailures: failures, checkedNeedleKinds: finalScan.checkedNeedleKinds };
}

export async function finalizeConversationEvidence(
  options: FinalizeConversationEvidenceOptions,
): Promise<FinalizedConversationEvidence> {
  if (options.generation !== undefined && options.generation !== 0) {
    throw new Error('initial conversation evidence finalization only supports generation 0');
  }
  const generation = options.generation ?? 0;
  validDigest(options.manifestDigest, 'manifestDigest');
  validDigest(options.buildDigest, 'buildDigest');
  if (typeof options.proofEligible !== 'boolean') throw new Error('proofEligible must be boolean');
  const now = (options.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) throw new Error('evidence finalization time is invalid');
  if (!Array.isArray(options.privateEvidenceNeedles) || options.privateEvidenceNeedles.length === 0
    || options.privateEvidenceNeedles.some((needle) => (
      !needle || (typeof needle.value === 'string' ? needle.value.length === 0 : needle.value.byteLength === 0)
  ))) {
    throw new Error('at least one non-empty private evidence needle is required');
  }
  assertNoFinalizerSerializationCollision(options, now.toISOString());
  const root = await validateEvidenceRoot(options.root);
  for (const reserved of [attestationFileName, outcomeFileName, revocationFileName]) {
    if (await pathExists(path.join(root, reserved))) {
      throw new Error(`conversation evidence finalization reserved file already exists: ${reserved}`);
    }
  }
  const sanitized = await sanitizePrivacyFailures(root, options.privateEvidenceNeedles);
  const outcome: ConversationEvidenceOutcome = {
    schemaVersion: 1,
    kind: 'conversation-evidence-outcome',
    manifestDigest: options.manifestDigest,
    buildDigest: options.buildDigest,
    proofEligible: options.proofEligible && sanitized.privacyFailures.length === 0,
    generatedAt: now.toISOString(),
    checkedNeedleKinds: sanitized.checkedNeedleKinds,
    privacyFailures: sanitized.privacyFailures,
  };
  await durableWriteExclusive(
    path.join(root, outcomeFileName),
    `${JSON.stringify(outcome, null, 2)}\n`,
  );
  await scanRetainedEvidenceTree(root, options.privateEvidenceNeedles);
  const seal = await createEvidenceSeal(root, attestationFileName, { generation });
  const verified = await verifyEvidenceSeal(root, attestationFileName, {
    expectedGeneration: generation,
    expectedParentIndexHash: null,
  });
  return { outcome, seal, attestationSha256: verified.attestationSha256 };
}

export const conversationEvidenceAttestationFile = attestationFileName;
export const conversationEvidenceOutcomeFile = outcomeFileName;
