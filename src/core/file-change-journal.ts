import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { withExclusiveFileLock } from './state-file.js';

const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const MAX_RUN_BYTES = 20 * 1024 * 1024;

const fileStateSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
  sha256: z.string().optional(),
  content: z.string().optional(),
  mode: z.number().int().optional(),
});
const entrySchema = z.object({
  id: z.string(),
  operation: z.string(),
  createdAt: z.string(),
  status: z.enum(['prepared', 'committed']),
  before: z.array(fileStateSchema),
  after: z.array(fileStateSchema).optional(),
});
const journalSchema = z.object({
  version: z.literal(1),
  runId: z.string(),
  workspaceRoot: z.string(),
  entries: z.array(entrySchema),
});
type FileState = z.infer<typeof fileStateSchema>;
type Journal = z.infer<typeof journalSchema>;

export interface FileMutationObserver {
  prepare(operation: string, paths: readonly string[]): Promise<string | undefined>;
  commit(token: string | undefined): Promise<void>;
}

async function snapshot(file: string): Promise<FileState> {
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: file, exists: false };
    throw error;
  }
  if (!info.isFile()) throw new Error(`变更日志只支持常规文件：${file}`);
  if (info.size > MAX_SNAPSHOT_BYTES) throw new Error(`文件超过 5MB，无法提供安全撤销：${file}`);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const content = await handle.readFile();
    return {
      path: file,
      exists: true,
      sha256: createHash('sha256').update(content).digest('hex'),
      content: content.toString('base64'),
      mode: info.mode & 0o777,
    };
  } finally {
    await handle.close();
  }
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

function safeRunFile(root: string, runId: string): string {
  const name = createHash('sha256').update(runId).digest('hex');
  return path.join(root, `${name}.json`);
}

export class FileChangeJournal implements FileMutationObserver {
  private lane: Promise<void> = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly workspaceRoot: string,
    private readonly currentRunId: () => string | undefined,
  ) {}

  async prepare(operation: string, paths: readonly string[]): Promise<string | undefined> {
    const runId = this.currentRunId();
    if (!runId) return undefined;
    const before = await Promise.all([...new Set(paths)].map(snapshot));
    const bytes = before.reduce((sum, state) =>
      sum + (state.content ? Buffer.byteLength(state.content, 'base64') : 0), 0);
    if (bytes > MAX_RUN_BYTES) throw new Error('本次变更快照超过 20MB，拒绝执行不可安全撤销的修改');
    const token = randomUUID();
    await this.serialized(async () => {
      const journal = await this.load(runId);
      const accumulated = journal.entries.reduce((sum, entry) =>
        sum + entry.before.reduce((inner, state) =>
          inner + (state.content ? Buffer.byteLength(state.content, 'base64') : 0), 0), 0);
      if (accumulated + bytes > MAX_RUN_BYTES) {
        throw new Error('当前 Run 的撤销快照累计超过 20MB，拒绝继续修改');
      }
      journal.entries.push({
        id: token,
        operation,
        createdAt: new Date().toISOString(),
        status: 'prepared',
        before,
      });
      await atomicJson(safeRunFile(this.root, runId), journal);
    });
    return token;
  }

  async commit(token: string | undefined): Promise<void> {
    if (!token) return;
    const runId = this.currentRunId();
    if (!runId) throw new Error('文件变更完成时 Run 已失效');
    await this.serialized(async () => {
      const journal = await this.load(runId);
      const entry = journal.entries.find((candidate) => candidate.id === token);
      if (!entry) throw new Error('找不到文件变更预记录');
      entry.after = (await Promise.all(entry.before.map((state) => snapshot(state.path))))
        .map(({ content: _content, ...state }) => state);
      entry.status = 'committed';
      await atomicJson(safeRunFile(this.root, runId), journal);
    });
  }

  async preview(runId: string): Promise<{ runId: string; operations: number; files: string[]; safe: boolean }> {
    const journal = await this.load(runId, false);
    const files = [...new Set(journal.entries.flatMap((entry) => entry.before.map((state) => state.path)))];
    return {
      runId,
      operations: journal.entries.length,
      files,
      safe: journal.entries.length > 0 && journal.entries.every((entry) => entry.status === 'committed'),
    };
  }

  async list(limit = 20): Promise<Array<{ runId: string; operations: number; files: string[]; safe: boolean }>> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const values = await Promise.all(names
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map(async (name) => {
        try {
          const journal = journalSchema.parse(JSON.parse(await readFile(path.join(this.root, name), 'utf8')));
          const preview = await this.preview(journal.runId);
          const updatedAt = Math.max(...journal.entries.map((entry) => Date.parse(entry.createdAt)), 0);
          return { ...preview, updatedAt };
        } catch {
          return undefined;
        }
      }));
    return values
      .filter((value): value is NonNullable<typeof value> => Boolean(value))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, Math.max(1, Math.min(100, limit)))
      .map(({ updatedAt: _updatedAt, ...preview }) => preview);
  }

  async undo(runId: string): Promise<{ restored: string[] }> {
    const journal = await this.load(runId, false);
    if (!journal.entries.length || journal.entries.some((entry) => entry.status !== 'committed' || !entry.after)) {
      throw new Error('该 Run 没有完整的可撤销变更记录');
    }
    const targets = [...new Set(journal.entries.flatMap((entry) => entry.before.map((state) => state.path)))].sort();
    const canonicalWorkspace = await realpath(this.workspaceRoot).catch(() => path.resolve(this.workspaceRoot));
    for (const target of targets) {
      const canonicalTarget = await realpath(target).catch(() => path.resolve(target));
      const relative = path.relative(canonicalWorkspace, canonicalTarget);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`撤销目标超出工作区：${target}`);
    }
    const restored = await this.withLocks(targets, async () => {
      const values: string[] = [];
      for (const entry of [...journal.entries].reverse()) {
        for (let index = entry.before.length - 1; index >= 0; index -= 1) {
          const before = entry.before[index]!;
          const after = entry.after![index]!;
          const current = await snapshot(before.path);
          if (current.exists !== after.exists || current.sha256 !== after.sha256) {
            throw new Error(`文件在 Run 后又被修改，拒绝撤销：${before.path}`);
          }
          if (!before.exists) {
            await rm(before.path, { force: true });
          } else {
            await mkdir(path.dirname(before.path), { recursive: true });
            const data = Buffer.from(before.content!, 'base64');
            const temporary = `${before.path}.${process.pid}.${randomUUID()}.undo`;
            try {
              await writeFile(temporary, data, { mode: before.mode ?? 0o600 });
              await rename(temporary, before.path);
            } finally {
              await rm(temporary, { force: true });
            }
          }
          values.push(before.path);
        }
      }
      return values;
    });
    await rename(
      safeRunFile(this.root, runId),
      `${safeRunFile(this.root, runId)}.undone-${Date.now()}`,
    );
    return { restored: [...new Set(restored)] };
  }

  private async load(runId: string, create = true): Promise<Journal> {
    const file = safeRunFile(this.root, runId);
    try {
      const value = journalSchema.parse(JSON.parse(await readFile(file, 'utf8')));
      if (value.runId !== runId || path.resolve(value.workspaceRoot) !== path.resolve(this.workspaceRoot)) {
        throw new Error('文件变更日志身份不匹配');
      }
      return value;
    } catch (error) {
      if (create && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, runId, workspaceRoot: this.workspaceRoot, entries: [] };
      }
      throw error;
    }
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lane.then(operation, operation);
    this.lane = result.then(() => undefined, () => undefined);
    return result;
  }

  private withLocks<T>(targets: readonly string[], operation: () => Promise<T>): Promise<T> {
    const acquire = (index: number): Promise<T> => index >= targets.length
      ? operation()
      : withExclusiveFileLock(targets[index]!, () => acquire(index + 1));
    return acquire(0);
  }
}
