// Shared lexical discovery for Tool and Skill metadata. This ranks catalog
// results only; it never routes owner input or grants execution permissions.
const STOP_WORDS = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'or', 'the', 'to', 'with']);
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });

export function normalizeCapabilityQuery(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function terms(value: string): string[] {
  return [...new Set([...segmenter.segment(normalizeCapabilityQuery(value))]
    .filter(part => part.isWordLike)
    .map(part => part.segment)
    .filter(term => (term.length > 1 || /\p{Script=Han}/u.test(term)) && !STOP_WORDS.has(term)))];
}

export function capabilityQueryOverlap(query: string, searchable: string): number {
  const normalizedQuery = normalizeCapabilityQuery(query);
  const normalizedSearchable = normalizeCapabilityQuery(searchable);
  const queryTerms = terms(query);
  if (!queryTerms.length || !normalizedSearchable) return 0;
  if (normalizedSearchable.includes(normalizedQuery)) return 1_000;
  return queryTerms.filter(term => normalizedSearchable.includes(term)).length;
}

export function matchesCapabilityQuery(query: string, searchable: string): number {
  const overlap = capabilityQueryOverlap(query, searchable);
  if (overlap >= 1_000) return overlap;
  return overlap >= Math.min(2, terms(query).length) ? overlap : 0;
}
