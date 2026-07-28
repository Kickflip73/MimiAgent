import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { SourceRef } from '../../core/memory.js';

function directoryFor(source: SourceRef): string {
  if (source.type === 'user-explicit') return 'user';
  if (source.type === 'session') return 'sessions';
  if (source.type === 'mimi-event') return 'events';
  return 'tools';
}

export class RawEvidenceStore {
  constructor(readonly root: string) {}

  async initialize(): Promise<void> {
    for (const directory of ['user', 'sessions', 'events', 'tools']) {
      await mkdir(path.join(this.root, directory), { recursive: true, mode: 0o700 });
    }
  }

  async preserve(source: SourceRef, content: string): Promise<string> {
    const bounded = content.trim().slice(0, 32_000);
    if (!bounded) throw new Error('Raw evidence 内容不能为空');
    const digest = createHash('sha256').update(bounded).digest('hex');
    const sourceDigest = source.digest.replace(/^sha256:/, '').slice(0, 16);
    const file = path.join(this.root, directoryFor(source), `${sourceDigest}-${digest.slice(0, 16)}.md`);
    const document = [
      '---',
      stringifyYaml({ schemaVersion: 1, immutable: true, sourceRef: source }, { lineWidth: 0 }).trimEnd(),
      '---',
      '',
      bounded,
      '',
    ].join('\n');
    try {
      const handle = await open(file, 'wx', 0o600);
      try {
        await handle.writeFile(document, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await readFile(file, 'utf8') !== document) {
        throw new Error(`Raw evidence 内容寻址冲突：${file}`);
      }
    }
    return file;
  }
}
