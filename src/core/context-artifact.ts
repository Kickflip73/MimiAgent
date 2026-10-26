/** Character offsets refer to this exact text, not tokens or bytes. */
export function contextArtifactPage(output: unknown, offset = 0, limit = 12_000) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 24_000) {
    throw new RangeError('Context Artifact offset must be a nonnegative integer; limit must be 1..24000 characters');
  }
  const source = typeof output === 'string' ? output : JSON.stringify(output ?? null);
  const start = Math.min(offset, source.length);
  let end = Math.min(source.length, start + limit);
  if (end < source.length && /[\uD800-\uDBFF]/u.test(source[end - 1] ?? '')) end -= 1;
  // A one-character page must still make progress when it meets a surrogate pair.
  if (end === start && end < source.length) end = Math.min(source.length, start + 2);
  const truncated = start > 0 || end < source.length;
  return {
    output: !truncated ? structuredClone(output) : source.slice(start, end),
    offset: start,
    totalChars: source.length,
    ...(end < source.length ? { nextOffset: end } : {}),
    truncated,
    format: typeof output === 'string' ? 'text' : 'json',
  };
}
