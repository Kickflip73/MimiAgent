import type { SourceRef } from '../../core/memory.js';

function sourceKey(source: SourceRef): string {
  return `${source.type}\0${source.id}\0${source.digest}`;
}

export function mergeSourceRefs(...groups: ReadonlyArray<readonly SourceRef[]>): SourceRef[] {
  const sources = new Map<string, SourceRef>();
  for (const source of groups.flat()) sources.set(sourceKey(source), source);
  return [...sources.values()]
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
    .slice(-50);
}

export function wikiLinks(body: string): string[] {
  return [...body.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]+)?\]\]/g)]
    .map((match) => match[1]!.trim())
    .filter(Boolean);
}

export function extractWikiContent(content: string): string {
  const trimmed = content.trim();
  const match = /^##\s+(?:摘要|当前结论)\s*$\r?\n([\s\S]*?)(?=^##\s+(?:关系|关联知识|来源|冲突与历史)\s*$|(?![\s\S]))/m.exec(trimmed);
  if (match?.[1]?.trim()) return match[1].trim();
  let body = trimmed
    .replace(/^#\s+.*(?:\r?\n|$)/gm, '')
    .replace(/^##\s+(?:摘要|当前结论)\s*$(?:\r?\n)?/gm, '');
  const sourceHeadings = [...body.matchAll(/^##\s+来源\s*$/gm)];
  const finalProvenance = [...sourceHeadings].reverse().find((heading) =>
    body.slice(heading.index).includes('[source:'));
  if (finalProvenance?.index !== undefined) body = body.slice(0, finalProvenance.index);
  body = body
    .replace(/^##\s+来源\s*$/gm, '### 来源信息')
    .replace(/^- \[source:[^\]]+\]\s*$/gm, '');
  return body.trim();
}

export function renderWikiPage(input: {
  title: string;
  content: string;
  sources: readonly SourceRef[];
  links?: readonly string[];
}): string {
  const content = extractWikiContent(input.content).slice(0, 120_000);
  const links = [...new Set(input.links?.map((link) => link.trim()).filter(Boolean) ?? [])]
    .filter((link) => link.toLocaleLowerCase('en-US') !== input.title.trim().toLocaleLowerCase('en-US'));
  const relations = links.length
    ? `\n\n## 关系\n\n${links.map((link) => `- [[${link}]]`).join('\n')}`
    : '';
  const sources = mergeSourceRefs(input.sources);
  return [
    `# ${input.title.trim()}`,
    '',
    '## 当前结论',
    '',
    content,
    relations,
    '',
    '## 来源',
    '',
    ...sources.map((source) => `- [source:${source.type}:${source.id}:${source.digest}]`),
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
