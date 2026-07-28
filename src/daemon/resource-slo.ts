import os from 'node:os';

export interface DailyUsageSample {
  at: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  cpuSeconds: number | null;
  memoryBytes: number | null;
  diskBytes: number | null;
}

export interface ResourceBudgets {
  runs: number;
  tokens: number;
  costUsd: number;
  cpuSeconds: number;
  memoryBytes: number;
  diskBytes: number;
}

export interface DailyResourceTrend {
  day: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number | null;
  cpuSeconds: number | null;
  peakMemoryBytes: number | null;
  peakDiskBytes: number | null;
  sampling: {
    cost: 'known' | 'unknown';
    host: 'sampled' | 'not_sampled';
  };
  alerts: string[];
}

export const DEFAULT_RESOURCE_BUDGETS: Readonly<ResourceBudgets> = Object.freeze({
  runs: 100,
  tokens: 2_000_000,
  costUsd: 25,
  cpuSeconds: 6 * 60 * 60,
  memoryBytes: 2 * 1024 * 1024 * 1024,
  diskBytes: 5 * 1024 * 1024 * 1024,
});

export function processResourceSample(
  diskBytes: number,
  at = new Date(),
): DailyUsageSample {
  const usage = process.resourceUsage();
  return {
    at: at.toISOString(),
    runs: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    cpuSeconds: (usage.userCPUTime + usage.systemCPUTime) / 1_000_000,
    memoryBytes: process.memoryUsage().rss,
    diskBytes,
  };
}

export function buildDailyResourceTrends(
  samples: readonly DailyUsageSample[],
  budgets: ResourceBudgets = DEFAULT_RESOURCE_BUDGETS,
  timezoneOffsetMinutes = -new Date().getTimezoneOffset(),
): DailyResourceTrend[] {
  const daily = new Map<string, DailyResourceTrend>();
  const offsetMs = timezoneOffsetMinutes * 60_000;
  for (const sample of samples) {
    const timestamp = Date.parse(sample.at);
    if (!Number.isFinite(timestamp)) throw new Error('资源样本时间无效');
    const day = new Date(timestamp + offsetMs).toISOString().slice(0, 10);
    const hostSampled = sample.cpuSeconds !== null
      && sample.memoryBytes !== null
      && sample.diskBytes !== null;
    const current = daily.get(day) ?? {
      day,
      runs: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: sample.costUsd === null ? null : 0,
      cpuSeconds: hostSampled ? 0 : null,
      peakMemoryBytes: hostSampled ? 0 : null,
      peakDiskBytes: hostSampled ? 0 : null,
      sampling: {
        cost: sample.costUsd === null ? 'unknown' as const : 'known' as const,
        host: hostSampled ? 'sampled' as const : 'not_sampled' as const,
      },
      alerts: [],
    };
    current.runs += bounded(sample.runs, 'runs');
    current.inputTokens += bounded(sample.inputTokens, 'inputTokens');
    current.outputTokens += bounded(sample.outputTokens, 'outputTokens');
    current.totalTokens = current.inputTokens + current.outputTokens;
    if (current.costUsd === null || sample.costUsd === null) {
      current.costUsd = null;
      current.sampling.cost = 'unknown';
    } else {
      current.costUsd += bounded(sample.costUsd, 'costUsd');
    }
    if (current.sampling.host === 'not_sampled' || !hostSampled) {
      current.cpuSeconds = null;
      current.peakMemoryBytes = null;
      current.peakDiskBytes = null;
      current.sampling.host = 'not_sampled';
    } else {
      current.cpuSeconds = (current.cpuSeconds ?? 0) + bounded(sample.cpuSeconds!, 'cpuSeconds');
      current.peakMemoryBytes = Math.max(current.peakMemoryBytes ?? 0, bounded(sample.memoryBytes!, 'memoryBytes'));
      current.peakDiskBytes = Math.max(current.peakDiskBytes ?? 0, bounded(sample.diskBytes!, 'diskBytes'));
    }
    daily.set(day, current);
  }
  for (const trend of daily.values()) {
    const alerts: string[] = [];
    if (trend.runs > budgets.runs) alerts.push('runs_budget_exceeded');
    if (trend.totalTokens > budgets.tokens) alerts.push('tokens_budget_exceeded');
    if (trend.costUsd !== null && trend.costUsd > budgets.costUsd) alerts.push('cost_budget_exceeded');
    if (trend.cpuSeconds !== null && trend.cpuSeconds > budgets.cpuSeconds) alerts.push('cpu_budget_exceeded');
    if (trend.peakMemoryBytes !== null && trend.peakMemoryBytes > budgets.memoryBytes) alerts.push('memory_budget_exceeded');
    if (trend.peakDiskBytes !== null && trend.peakDiskBytes > budgets.diskBytes) alerts.push('disk_budget_exceeded');
    trend.alerts = alerts;
  }
  return [...daily.values()].sort((left, right) => left.day.localeCompare(right.day));
}

export function resourceHostSummary(): {
  cpuCount: number;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  loadAverage: number[];
} {
  return {
    cpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    loadAverage: os.loadavg(),
  };
}

function bounded(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} 必须是非负有限数`);
  return value;
}
