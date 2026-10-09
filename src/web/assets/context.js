export function contextBreakdown(info = {}, snapshot = {}) {
  const valid = value => Number.isFinite(value) && value >= 0;
  const total = valid(info.contextWindow) ? info.contextWindow : snapshot.contextWindow;
  const used = [info.lastRequestInputTokens, info.estimatedTokens, snapshot.contextUsed].find(valid);
  const actual = valid(info.lastRequestInputTokens) || info.source === 'actual' || (!Object.keys(info).length && snapshot.contextStatus?.source === 'actual');
  // Protocol reserve is capacity held aside, not tokens sent to a model.
  const sections = (info.sections || []).filter(s => s.id !== 'protocol-reserve' && valid(s.estimatedTokens) && s.estimatedTokens > 0);
  const sum = sections.reduce((n,s) => n + s.estimatedTokens, 0);
  return { total, used, actual, percent: valid(total) && total > 0 && valid(used) ? used / total * 100 : undefined,
    sections: sections.map(s => ({ ...s, share: sum > 0 && valid(used) ? s.estimatedTokens / sum * used : s.estimatedTokens })),
    remaining: valid(total) && valid(used) ? Math.max(0,total-used) : undefined,
  };
}
