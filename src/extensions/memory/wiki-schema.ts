import { z } from 'zod';
import { parse as parseYaml } from 'yaml';

export const sourceRefSchema = z.object({
  type: z.enum(['file', 'session', 'mimi-event', 'user-explicit', 'memory']),
  id: z.string().min(1).max(1_000),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  occurredAt: z.string().datetime(),
  trust: z.enum(['owner', 'trusted', 'external', 'public', 'system']),
}).strict();

export const memoryPageMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^mem_[a-zA-Z0-9_-]{8,100}$/),
  canonicalKey: z.string().trim().min(1).max(500).optional(),
  title: z.string().trim().min(1).max(200),
  kind: z.enum(['profile', 'fact', 'concept', 'entity', 'decision', 'lesson', 'source-summary', 'synthesis', 'procedure-ref']),
  scope: z.enum(['private', 'workspace']),
  profileId: z.string().min(1).max(100).nullable(),
  status: z.enum(['proposed', 'active', 'conflicted', 'superseded', 'expired']),
  confidence: z.enum(['user-confirmed', 'source-grounded', 'inferred']),
  aliases: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
  tags: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
  sourceRefs: z.array(sourceRefSchema).min(1).max(50),
  validFrom: z.string().datetime().nullable(),
  validUntil: z.string().datetime().nullable(),
  lastVerifiedAt: z.string().datetime().nullable().optional(),
  refreshAfter: z.string().datetime().nullable().optional(),
  mergedInto: z.string().regex(/^mem_[a-zA-Z0-9_-]{8,100}$/).nullable().optional(),
  supersedes: z.array(z.string()).max(30).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  if (value.scope === 'private' && !value.profileId) {
    context.addIssue({ code: 'custom', path: ['profileId'], message: 'private 页面必须绑定 profileId' });
  }
  if (value.scope === 'workspace' && value.profileId !== null) {
    context.addIssue({ code: 'custom', path: ['profileId'], message: 'workspace 页面不能绑定 profileId' });
  }
});

export const wikiSchemaPolicySchema = z.object({
  schemaVersion: z.literal(1),
  preferExistingTopic: z.boolean().default(true),
  requireSourceRefs: z.boolean().default(true),
  requireCanonicalKey: z.boolean().default(true),
  allowInferredActive: z.boolean().default(false),
  maxPageBytes: z.number().int().min(10_000).max(200_000).default(200_000),
  maxSourcesPerPage: z.number().int().min(1).max(50).default(50),
  requireLinksForKinds: z.array(z.enum([
    'profile', 'fact', 'concept', 'entity', 'decision', 'lesson',
    'source-summary', 'synthesis', 'procedure-ref',
  ])).max(9).default(['concept', 'entity', 'decision', 'lesson', 'synthesis']),
}).strict();

export type WikiSchemaPolicy = z.infer<typeof wikiSchemaPolicySchema>;

export const DEFAULT_WIKI_SCHEMA_POLICY: WikiSchemaPolicy = {
  schemaVersion: 1,
  preferExistingTopic: true,
  requireSourceRefs: true,
  requireCanonicalKey: true,
  allowInferredActive: false,
  maxPageBytes: 200_000,
  maxSourcesPerPage: 50,
  requireLinksForKinds: ['concept', 'entity', 'decision', 'lesson', 'synthesis'],
};

export function parseWikiSchemaPolicy(source: string): WikiSchemaPolicy {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) return DEFAULT_WIKI_SCHEMA_POLICY;
  return wikiSchemaPolicySchema.parse(parseYaml(match[1]!));
}

export const DEFAULT_WIKI_SCHEMA_FRONTMATTER = `---
schemaVersion: 1
preferExistingTopic: true
requireSourceRefs: true
requireCanonicalKey: true
allowInferredActive: false
maxPageBytes: 200000
maxSourcesPerPage: 50
requireLinksForKinds:
  - concept
  - entity
  - decision
  - lesson
  - synthesis
---`;

export function ensureWikiSchemaFrontmatter(source: string): string {
  if (/^---\r?\n/.test(source)) return source;
  return `${DEFAULT_WIKI_SCHEMA_FRONTMATTER}\n\n${source.trim()}\n`;
}

export const DEFAULT_WIKI_SCHEMA = `${DEFAULT_WIKI_SCHEMA_FRONTMATTER}

# MimiAgent Wiki Maintenance Contract

- 每个页面只表达一个稳定主题，并保留逐项 SourceRef。
- 更新现有主题优先于创建重复页面；无法裁决的矛盾标记为 conflicted。
- private 内容不得写入 workspace Wiki，外部事件原文不得成为项目知识。
- knowledge/sources 是不可变证据；更新来源必须创建新版本并使用 supersedes 关联。
- WIKI.md 只能收紧分类和维护偏好，不能扩大 scope、trust 或工具权限。
- 模型提交结构化内容；页面标题、关系与来源章节由确定性 renderer 生成。
- inferred 内容默认保持 proposed，只有 owner 或可靠来源可以晋级为 active。
`;
