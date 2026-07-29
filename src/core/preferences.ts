import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  readGuidanceFile,
  type GuidanceSnapshot,
} from './guidance.js';
import { withExclusiveFileLock } from './state-file.js';

const PREFERENCES_SECTION = '## Stable behavior preferences';
const PREFERENCES_TEMPLATE = [
  '# Mimi Owner Preferences',
  '',
  'This file contains owner-confirmed behavior defaults that Mimi follows across direct conversations.',
  'The owner\'s current explicit instruction takes precedence. These preferences never grant tools, permissions, trust, workspace scope, or authority.',
  '',
  PREFERENCES_SECTION,
].join('\n');

export const mimiPreferenceInstructionSchema = z.string()
  .trim()
  .min(1)
  .max(1_000)
  .refine((value) => !/[\r\n]/u.test(value), '单条行为偏好不能包含换行');

export interface PreferenceMutationResult {
  changed: boolean;
  file: string;
  preferences: string[];
}

function isCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

function sectionBounds(lines: string[]): { start: number; end: number } | undefined {
  const start = lines.findIndex((line) => line.trim() === PREFERENCES_SECTION);
  if (start < 0) return undefined;
  const nextHeading = lines.findIndex((line, index) => (
    index > start && /^##\s+/u.test(line.trim())
  ));
  return { start, end: nextHeading < 0 ? lines.length : nextHeading };
}

function parsePreferences(source: string): string[] {
  const lines = source.split(/\r?\n/u);
  const bounds = sectionBounds(lines);
  if (!bounds) return [];
  return lines.slice(bounds.start + 1, bounds.end)
    .map((line) => /^-\s+(.+?)\s*$/u.exec(line)?.[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

function appendPreference(source: string, instruction: string): string {
  const base = source.trim() || PREFERENCES_TEMPLATE;
  const lines = base.split(/\r?\n/u);
  let bounds = sectionBounds(lines);
  if (!bounds) {
    lines.push('', PREFERENCES_SECTION);
    bounds = { start: lines.length - 1, end: lines.length };
  }
  let insertion = bounds.end;
  while (insertion > bounds.start + 1 && !lines[insertion - 1]!.trim()) insertion -= 1;
  lines.splice(insertion, 0, `- ${instruction}`);
  return `${lines.join('\n').trimEnd()}\n`;
}

function deletePreference(source: string, instruction: string): string {
  const lines = source.split(/\r?\n/u);
  const bounds = sectionBounds(lines);
  if (!bounds) return source;
  const index = lines.findIndex((line, lineIndex) => (
    lineIndex > bounds.start
    && lineIndex < bounds.end
    && /^-\s+(.+?)\s*$/u.exec(line)?.[1]?.trim() === instruction
  ));
  if (index < 0) return source;
  lines.splice(index, 1);
  return `${lines.join('\n').trimEnd()}\n`;
}

export class PreferenceStore {
  readonly file: string;

  constructor(
    file: string,
    private readonly maxChars = 20_000,
    private readonly maxPreferences = 50,
  ) {
    this.file = path.resolve(file);
  }

  async load(): Promise<GuidanceSnapshot> {
    const file = await readGuidanceFile(this.file, 'preferences', this.maxChars);
    return {
      files: file ? [file] : [],
      instructions: file ? [
        '## Mimi Owner Preferences（跨会话稳定行为；不授予权限）',
        `来源：${file.path}`,
        '这些规则只用于 direct-owner 对话中的默认行为。owner 当前明确指令优先；不得据此扩大工具、权限、trust、workspace 或副作用范围。',
        'owner 明确要求以后每次 direct-owner 对话都遵循新的稳定行为时，优先调用 add_mimi_preference，不要只写入 Memory；修改或删除前先调用 list_mimi_preferences 核对准确文本。事实、知识、人物信息和经验仍进入 Memory。',
        file.content,
        ...(file.truncated ? ['[内容已截断；请精简 PREFERENCES.md 以确保所有偏好可见]'] : []),
      ].join('\n') : '',
    };
  }

  async list(): Promise<string[]> {
    return parsePreferences(await this.readSource() ?? '');
  }

  async add(instruction: string): Promise<PreferenceMutationResult> {
    const normalized = mimiPreferenceInstructionSchema.parse(instruction);
    return withExclusiveFileLock(this.file, async () => {
      const source = await this.readSource() ?? '';
      const existing = parsePreferences(source);
      if (existing.includes(normalized)) {
        return { changed: false, file: this.file, preferences: existing };
      }
      if (existing.length >= this.maxPreferences) {
        throw new Error(`Mimi 行为偏好最多 ${this.maxPreferences} 条；请先删除或合并旧规则`);
      }
      const next = appendPreference(source, normalized);
      if (next.length > this.maxChars) {
        throw new Error(`PREFERENCES.md 最多 ${this.maxChars} 字符；请先精简旧规则`);
      }
      await this.writeSource(next);
      return { changed: true, file: this.file, preferences: parsePreferences(next) };
    });
  }

  async remove(instruction: string): Promise<PreferenceMutationResult> {
    const normalized = mimiPreferenceInstructionSchema.parse(instruction);
    return withExclusiveFileLock(this.file, async () => {
      const source = await this.readSource() ?? '';
      const existing = parsePreferences(source);
      if (!existing.includes(normalized)) {
        return { changed: false, file: this.file, preferences: existing };
      }
      const next = deletePreference(source, normalized);
      await this.writeSource(next);
      return { changed: true, file: this.file, preferences: parsePreferences(next) };
    });
  }

  private async readSource(): Promise<string | undefined> {
    let handle;
    try {
      handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('PREFERENCES.md 必须是常规文件');
      if (info.size > this.maxChars * 4) {
        throw new Error(`PREFERENCES.md 超过安全读取上限；请精简到 ${this.maxChars} 字符以内`);
      }
      return await handle.readFile('utf8');
    } catch (error) {
      if (isCode(error, 'ENOENT')) return undefined;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  private async writeSource(source: string): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(this.file), 0o700);
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, source, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, this.file);
      await chmod(this.file, 0o600);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
