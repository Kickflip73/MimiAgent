import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { SourceRef } from '../../core/memory.js';
import { withExclusiveFileLock } from '../../core/state-file.js';

function directoryFor(source: SourceRef): string {
  if (source.type === 'user-explicit') return 'user';
  if (source.type === 'session') return 'sessions';
  if (source.type === 'mimi-event') return 'events';
  return 'tools';
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function writeImmutable(file: string, content: string): Promise<boolean> {
  try {
    const handle = await open(file, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (await readFile(file, 'utf8') !== content) {
      throw new Error(`Raw evidence 内容寻址冲突：${file}`);
    }
    return false;
  }
}

export interface RawEvidenceCommit {
  blobDigest: string;
  blobPath: string;
  referencePath: string;
}

/**
 * Stores immutable content separately from per-observation provenance.
 * Schema-v1 Markdown files remain readable historical evidence and are never
 * rewritten; new writes converge on one blob plus one reference per source.
 */
export class RawEvidenceStore {
  constructor(readonly root: string) {}

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(path.join(this.root, 'blobs'), { recursive: true, mode: 0o700 }),
      ...['user', 'sessions', 'events', 'tools'].flatMap((directory) => [
        // Legacy schema-v1 location, retained read-only for compatibility.
        mkdir(path.join(this.root, directory), { recursive: true, mode: 0o700 }),
        mkdir(path.join(this.root, 'refs', directory), { recursive: true, mode: 0o700 }),
      ]),
    ]);
  }

  async preserve(source: SourceRef, content: string): Promise<string> {
    return (await this.commit(source, content, () => undefined)).referencePath;
  }

  async commit<T>(
    source: SourceRef,
    content: string,
    operation: () => T | Promise<T>,
  ): Promise<RawEvidenceCommit & { result: T }> {
    const bounded = content.trim().slice(0, 32_000);
    if (!bounded) throw new Error('Raw evidence 内容不能为空');
    return withExclusiveFileLock(path.join(this.root, '.raw-evidence-v2'), async () => {
      await this.initialize();
      const blobDigest = digest(bounded);
      const blobPath = path.join(this.root, 'blobs', `${blobDigest}.txt`);
      const sourceKey = JSON.stringify({
        type: source.type,
        id: source.id,
        digest: source.digest,
        occurredAt: source.occurredAt,
        trust: source.trust,
      });
      const referencePath = path.join(
        this.root,
        'refs',
        directoryFor(source),
        `${digest(sourceKey)}.json`,
      );
      const reference = `${JSON.stringify({
        schemaVersion: 2,
        immutable: true,
        sourceRef: source,
        blob: {
          digest: `sha256:${blobDigest}`,
          path: path.relative(path.dirname(referencePath), blobPath),
        },
      }, null, 2)}\n`;
      const createdBlob = await writeImmutable(blobPath, bounded);
      let createdReference = false;
      try {
        createdReference = await writeImmutable(referencePath, reference);
        const result = await operation();
        return { blobDigest, blobPath, referencePath, result };
      } catch (error) {
        if (createdReference) await rm(referencePath, { force: true });
        if (createdBlob && createdReference) await rm(blobPath, { force: true });
        throw error;
      }
    });
  }
}
