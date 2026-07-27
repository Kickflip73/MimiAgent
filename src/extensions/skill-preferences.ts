import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { withExclusiveFileLock } from '../core/state-file.js';

export type SkillPreferenceScope = 'project' | 'user';

const stateSchema = z.object({
  version: z.literal(1),
  disabled: z.array(z.string().min(1).max(64)).max(200),
}).strict();

export interface SkillPreference {
  disabled: boolean;
  scope?: SkillPreferenceScope;
}

async function readState(file: string): Promise<Set<string>> {
  try {
    const value = stateSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    return new Set(value.disabled);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw new Error(`Skill 状态文件无效 ${file}：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function atomicWriteState(file: string, disabled: Set<string>): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({
      version: 1,
      disabled: [...disabled].sort(),
    }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export class SkillPreferenceStore {
  private project = new Set<string>();
  private user = new Set<string>();

  constructor(
    readonly projectFile: string,
    readonly userFile: string,
  ) {}

  async load(): Promise<void> {
    [this.project, this.user] = await Promise.all([
      readState(this.projectFile),
      readState(this.userFile),
    ]);
  }

  preference(name: string): SkillPreference {
    if (this.project.has(name)) return { disabled: true, scope: 'project' };
    if (this.user.has(name)) return { disabled: true, scope: 'user' };
    return { disabled: false };
  }

  async set(name: string, scope: SkillPreferenceScope, enabled: boolean): Promise<void> {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error(`Skill 名称无效：${name}`);
    const file = scope === 'project' ? this.projectFile : this.userFile;
    await withExclusiveFileLock(file, async () => {
      const target = await readState(file);
      if (enabled) target.delete(name);
      else target.add(name);
      await atomicWriteState(file, target);
      if (scope === 'project') this.project = target;
      else this.user = target;
    });
  }
}
