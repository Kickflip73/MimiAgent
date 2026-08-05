import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tool } from '@openai/agents';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { estimateTokens } from '../core/context.js';
import type {
  ActivatedSkill,
  SkillActivationStatus,
} from '../core/session.js';
import { SkillPreferenceStore, type SkillPreferenceScope } from './skill-preferences.js';

const metadataSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().min(1).max(1024),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  'allowed-tools': z.string().optional(),
  'required-tools': z.union([z.string(), z.array(z.string().min(1))]).optional(),
}).passthrough();

const builtinManifestSchema = z.object({
  schemaVersion: z.number().int().positive(),
  skills: z.array(z.object({
    name: z.string().min(1),
    published: z.boolean(),
  }).passthrough()),
}).strict();

const MAX_SKILL_BYTES = 512_000;
const MAX_RESOURCE_BYTES = 256_000;
const MAX_SKILLS = 200;
const MAX_TOTAL_SKILL_BYTES = 10_000_000;

export type SkillSourceId =
  | 'configured'
  | 'project-native'
  | 'project-shared'
  | 'user-native'
  | 'user-shared'
  | 'builtin';

export interface SkillSource {
  id: SkillSourceId;
  scope: 'configured' | 'project' | 'user' | 'builtin';
  root: string;
  precedence: number;
  manifest?: string;
}

export interface Skill {
  name: string;
  description: string;
  content: string;
  root: string;
  file: string;
  metadata: z.infer<typeof metadataSchema>;
  source: SkillSource;
  contentHash: string;
}

export interface SkillDiagnostic {
  kind: 'invalid' | 'shadowed' | 'limit' | 'source';
  message: string;
  sourceId?: SkillSourceId;
  path?: string;
  winner?: {
    name: string;
    sourceId: SkillSourceId;
    path: string;
  };
  loser?: {
    name: string;
    sourceId: SkillSourceId;
    path: string;
  };
}

export type SkillAvailabilityReason =
  | 'local-read-denied'
  | 'missing-required-tool'
  | 'stale-binding'
  | 'instruction-budget'
  | 'disabled-by-project'
  | 'disabled-by-user';

export interface SkillRunAccess {
  canReadLocal: boolean;
  availableTools?: readonly string[];
  binding?: ActivatedSkill;
  instructionBudget?: number;
}

export interface SkillAvailability {
  available: boolean;
  reasons: SkillAvailabilityReason[];
  missingTools: string[];
}

export interface SkillToolRuntime {
  access: () => SkillRunAccess;
  getBinding: (name: string) => Promise<ActivatedSkill | undefined>;
  activate: (skill: Skill) => Promise<SkillActivationStatus>;
}

async function readBoundedUtf8(file: string, maxBytes: number, label: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${label} 必须是常规文件`);
    if (info.size > maxBytes) throw new Error(`${label} 超过 ${Math.floor(maxBytes / 1_000)}KB`);
    const buffer = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new Error(`${label} 超过 ${Math.floor(maxBytes / 1_000)}KB`);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function parseFrontmatter(markdown: string): z.infer<typeof metadataSchema> {
  const match = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match?.[1]) throw new Error('SKILL.md 缺少 YAML frontmatter');
  try {
    return metadataSchema.parse(parseYaml(match[1]));
  } catch (error) {
    throw new Error(`Skill 元数据无效：${error instanceof Error ? error.message : String(error)}`);
  }
}

function legacySource(directory: string): SkillSource {
  return {
    id: 'configured',
    scope: 'configured',
    root: directory,
    precedence: 0,
  };
}

function diagnosticMessage(diagnostic: SkillDiagnostic): string {
  return diagnostic.message;
}

function normalizeAccess(accessOrTools?: readonly string[] | SkillRunAccess): SkillRunAccess {
  if (Array.isArray(accessOrTools)) {
    return { canReadLocal: true, availableTools: accessOrTools };
  }
  return (accessOrTools as SkillRunAccess | undefined) ?? { canReadLocal: true };
}

export class SkillLoader {
  private skills = new Map<string, Skill>();
  private issues: SkillDiagnostic[] = [];
  private readonly sources: SkillSource[];

  constructor(
    directoryOrSources: string | readonly SkillSource[],
    private readonly preferences?: SkillPreferenceStore,
  ) {
    this.sources = (typeof directoryOrSources === 'string'
      ? [legacySource(directoryOrSources)]
      : [...directoryOrSources])
      .sort((left, right) => left.precedence - right.precedence || left.id.localeCompare(right.id));
  }

  async load(): Promise<void> {
    await this.preferences?.load();
    this.skills.clear();
    this.issues = [];
    const seenFiles = new Set<string>();
    let totalBytes = 0;
    let limitReported = false;

    for (const source of this.sources) {
      const published = await this.publishedBuiltinNames(source);
      if (source.id === 'builtin' && !published) continue;
      let canonicalSourceRoot: string;
      let entries;
      try {
        canonicalSourceRoot = await realpath(source.root);
        entries = await readdir(canonicalSourceRoot, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        this.issues.push({
          kind: 'source',
          sourceId: source.id,
          path: source.root,
          message: `${source.id}: 无法扫描 ${source.root}：${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      const directories = entries
        .filter((entry) => entry.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name));

      for (const entry of directories) {
        if (source.id === 'builtin' && !published?.has(entry.name)) continue;
        const root = path.join(canonicalSourceRoot, entry.name);
        const candidateFile = path.join(root, 'SKILL.md');
        let file: string;
        try {
          file = await realpath(candidateFile);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          this.issues.push({
            kind: 'invalid',
            sourceId: source.id,
            path: candidateFile,
            message: `${source.id}/${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
          });
          continue;
        }
        if (seenFiles.has(file)) continue;
        seenFiles.add(file);

        try {
          const content = await readBoundedUtf8(file, MAX_SKILL_BYTES, 'SKILL.md');
          const metadata = parseFrontmatter(content);
          if (metadata.name !== entry.name) {
            throw new Error(`目录名 ${entry.name} 必须与 name ${metadata.name} 一致`);
          }
          const bytes = Buffer.byteLength(content, 'utf8');
          if (this.skills.size >= MAX_SKILLS || totalBytes + bytes > MAX_TOTAL_SKILL_BYTES) {
            if (!limitReported) {
              const message = this.skills.size >= MAX_SKILLS
                ? `有效 Skill 超过 ${MAX_SKILLS} 项，其余候选未注册`
                : 'Skill 总文本超过 10MB，其余候选未注册';
              this.issues.push({ kind: 'limit', sourceId: source.id, path: file, message });
              limitReported = true;
            }
            continue;
          }
          const canonicalRoot = path.dirname(file);
          const skill: Skill = {
            name: metadata.name,
            description: metadata.description,
            content,
            root: canonicalRoot,
            file,
            metadata,
            source: { ...source, root: canonicalSourceRoot },
            contentHash: createHash('sha256').update(content).digest('hex'),
          };
          const winner = this.skills.get(skill.name);
          if (winner) {
            this.issues.push({
              kind: 'shadowed',
              sourceId: source.id,
              path: file,
              winner: { name: winner.name, sourceId: winner.source.id, path: winner.file },
              loser: { name: skill.name, sourceId: skill.source.id, path: skill.file },
              message: `Skill ${skill.name}：${winner.source.id} (${winner.file}) 覆盖 ${skill.source.id} (${skill.file})`,
            });
            continue;
          }
          this.skills.set(skill.name, skill);
          totalBytes += bytes;
        } catch (error) {
          this.issues.push({
            kind: 'invalid',
            sourceId: source.id,
            path: file,
            message: `${source.id}/${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    }
  }

  catalog(
    accessOrTools?: readonly string[] | SkillRunAccess,
    options: { includeLocations?: boolean } = {},
  ): string {
    const access = normalizeAccess(accessOrTools);
    const includeLocations = options.includeLocations !== false;
    return [...this.skills.values()]
      .filter((skill) => this.evaluateAvailability(skill, access).available)
      .map((skill) => includeLocations
        ? [
            `- ${skill.name}: ${skill.description}`,
            `  source: ${skill.source.id}`,
            `  location: ${skill.file}`,
          ].join('\n')
        : `- ${skill.name}: ${skill.description}`)
      .join('\n');
  }

  list(): Array<Pick<Skill, 'name' | 'description' | 'root' | 'file' | 'source' | 'contentHash'>> {
    return [...this.skills.values()].map(({
      name,
      description,
      root,
      file,
      source,
      contentHash,
    }) => ({ name, description, root, file, source: { ...source }, contentHash }));
  }

  preference(name: string) {
    return this.preferences?.preference(name) ?? { disabled: false as const };
  }

  async setEnabled(name: string, scope: SkillPreferenceScope, enabled: boolean): Promise<void> {
    if (!this.skills.has(name) && enabled) throw new Error(`未找到 Skill：${name}`);
    if (!this.preferences) throw new Error('当前 Skill Loader 未配置持久状态存储');
    await this.preferences.set(name, scope, enabled);
  }

  diagnostics(): string[] {
    return this.issues.map(diagnosticMessage);
  }

  diagnosticDetails(): SkillDiagnostic[] {
    return this.issues.map((issue) => ({
      ...issue,
      winner: issue.winner ? { ...issue.winner } : undefined,
      loser: issue.loser ? { ...issue.loser } : undefined,
    }));
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  evaluateAvailability(skill: Skill, access: SkillRunAccess): SkillAvailability {
    const missingTools = this.missingRequiredTools(skill, access.availableTools);
    const reasons: SkillAvailabilityReason[] = [];
    const preference = this.preference(skill.name);
    if (preference.scope === 'project') reasons.push('disabled-by-project');
    if (preference.scope === 'user') reasons.push('disabled-by-user');
    if (!access.canReadLocal) reasons.push('local-read-denied');
    if (missingTools.length) reasons.push('missing-required-tool');
    if (access.binding && (
      access.binding.name !== skill.name
      || access.binding.sourceId !== skill.source.id
      || access.binding.file !== skill.file
      || access.binding.contentHash !== skill.contentHash
    )) {
      reasons.push('stale-binding');
    }
    if (access.instructionBudget !== undefined
      && estimateTokens(skill.content) > access.instructionBudget) {
      reasons.push('instruction-budget');
    }
    return { available: reasons.length === 0, reasons, missingTools };
  }

  activate(name: string, accessOrTools?: readonly string[] | SkillRunAccess): {
    name: string;
    root: string;
    file: string;
    sourceId: SkillSourceId;
    contentHash: string;
    instructions: string;
  } {
    const skill = this.get(name);
    if (!skill) throw new Error(`未找到 Skill：${name}`);
    const access = normalizeAccess(accessOrTools);
    this.assertAvailable(skill, this.evaluateAvailability(skill, access));
    return {
      name: skill.name,
      root: skill.root,
      file: skill.file,
      sourceId: skill.source.id,
      contentHash: skill.contentHash,
      instructions: skill.content,
    };
  }

  async readResource(name: string, resource: string): Promise<{ path: string; content: string }> {
    const skill = this.get(name);
    if (!skill) throw new Error(`未找到 Skill：${name}`);
    if (!resource || path.isAbsolute(resource)) throw new Error('Skill 资源必须是相对路径');
    const target = path.resolve(skill.root, resource);
    const relative = path.relative(skill.root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Skill 资源不能超出 Skill 目录');
    const [canonicalRoot, canonicalTarget] = await Promise.all([realpath(skill.root), realpath(target)]);
    const canonicalRelative = path.relative(canonicalRoot, canonicalTarget);
    if (canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) {
      throw new Error('Skill 资源不能通过符号链接超出 Skill 目录');
    }
    const content = await readBoundedUtf8(canonicalTarget, MAX_RESOURCE_BYTES, 'Skill 文本资源');
    return { path: canonicalTarget, content };
  }

  createTools(runtime?: (() => readonly string[] | undefined) | SkillToolRuntime) {
    const currentAccess = (): SkillRunAccess => typeof runtime === 'function'
      ? { canReadLocal: true, availableTools: runtime() }
      : runtime?.access() ?? { canReadLocal: true };
    return [
      tool({
        name: 'use_skill',
        description: '按名称激活匹配的 Agent Skill，返回完整说明和资源根目录。',
        parameters: z.object({ name: z.string().min(1) }),
        execute: async ({ name }) => {
          const skill = this.get(name);
          if (!skill) throw new Error(`未找到 Skill：${name}`);
          this.assertAvailable(skill, this.evaluateAvailability(skill, currentAccess()));
          const status = typeof runtime === 'function' || !runtime
            ? 'activated' as const
            : await runtime.activate(skill);
          if (status === 'stale_run') throw new Error(`Skill ${name} 激活失败：所属 Run 已失效`);
          if (status === 'already_active') {
            return {
              name: skill.name,
              sourceId: skill.source.id,
              contentHash: skill.contentHash,
              status,
            };
          }
          return { ...this.activate(name, currentAccess()), status };
        },
      }),
      tool({
        name: 'read_skill_resource',
        description: '读取已激活 Skill 中按需引用的文本资源，路径相对于该 Skill 根目录。',
        parameters: z.object({ name: z.string().min(1), path: z.string().min(1) }),
        execute: async ({ name, path: resource }) => {
          const skill = this.get(name);
          if (!skill) throw new Error(`未找到 Skill：${name}`);
          if (typeof runtime !== 'function' && runtime) {
            const binding = await runtime.getBinding(name);
            if (!binding) throw new Error(`Skill ${name} 尚未在当前 Session 激活`);
            this.assertAvailable(skill, this.evaluateAvailability(skill, {
              ...currentAccess(),
              binding,
            }));
          }
          return this.readResource(name, resource);
        },
      }),
      tool({
        name: 'list_skills',
        description: '列出可用 Agent Skills 及其位置。',
        parameters: z.object({}),
        execute: async () => this.list().filter((listed) => {
          const skill = this.get(listed.name);
          return skill && this.evaluateAvailability(skill, currentAccess()).available;
        }),
      }),
      tool({
        name: 'reload_skills',
        description: '重新扫描全部已配置的 Agent Skill 来源。',
        parameters: z.object({}),
        execute: async () => {
          await this.load();
          return { skills: this.list(), warnings: this.diagnostics() };
        },
      }),
    ];
  }

  private async publishedBuiltinNames(source: SkillSource): Promise<Set<string> | undefined> {
    if (source.id !== 'builtin') return new Set();
    const manifest = source.manifest ?? path.join(source.root, 'manifest.json');
    try {
      const value = builtinManifestSchema.parse(JSON.parse(await readFile(manifest, 'utf8')));
      return new Set(value.skills.filter((skill) => skill.published).map((skill) => skill.name));
    } catch (error) {
      this.issues.push({
        kind: 'source',
        sourceId: source.id,
        path: manifest,
        message: `builtin: manifest 无效，内置 Skills 已关闭：${error instanceof Error ? error.message : String(error)}`,
      });
      return undefined;
    }
  }

  private assertAvailable(skill: Skill, availability: SkillAvailability): void {
    if (availability.available) return;
    const details = availability.reasons.map((reason) => {
      if (reason === 'local-read-denied') return '当前 Run 无本地读取权';
      if (reason === 'missing-required-tool') return `缺少必需工具：${availability.missingTools.join(', ')}`;
      if (reason === 'stale-binding') return '激活绑定已过期，需要重新激活';
      if (reason === 'disabled-by-project') return '已在当前项目停用';
      if (reason === 'disabled-by-user') return '已在用户范围停用';
      return '完整指令超出本轮 instruction budget';
    });
    throw new Error(`Skill ${skill.name} 当前不可用：${details.join('；')}`);
  }

  private missingRequiredTools(skill: Skill, availableTools?: readonly string[]): string[] {
    const declared = skill.metadata['required-tools'];
    if (!declared || availableTools === undefined) return [];
    const required = (Array.isArray(declared) ? declared : declared.split(/[\s,]+/))
      .map((name) => name.trim())
      .filter(Boolean);
    const available = new Set(availableTools);
    return required.filter((name) => !available.has(name));
  }
}
