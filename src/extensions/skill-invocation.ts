export interface SkillInvocation {
  names: string[];
  prefixLength: number;
}

export function parseSkillInvocation(input: string, ownerTrusted: boolean): SkillInvocation {
  if (!ownerTrusted || !input.startsWith('$')) return { names: [], prefixLength: 0 };
  const names: string[] = [];
  const seen = new Set<string>();
  let offset = 0;
  while (input[offset] === '$') {
    const match = input.slice(offset).match(/^\$([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/);
    const name = match?.[1];
    if (!name || !match) break;
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
    offset += match[0].length;
    while (/\s/u.test(input[offset] ?? '')) offset += 1;
  }
  return { names, prefixLength: names.length ? offset : 0 };
}
