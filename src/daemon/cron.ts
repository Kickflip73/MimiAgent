/** Five-field cron in the daemon's local timezone. No timer or execution ownership here. */
function field(source: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of source.split(',')) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error('cron 字段格式无效');
    const step = Number(match[2] ?? 1);
    const range = match[1]!.split('-').map(Number);
    const start = match[1] === '*' ? min : range[0]!;
    const end = match[1] === '*' ? max : range[1] ?? (match[2] ? max : start);
    if (!Number.isSafeInteger(step) || step < 1 || step > max - min + 1 || start < min || end > max || start > end) throw new Error('cron 字段超出范围');
    for (let n = start; n <= end; n += step) values.add(n);
  }
  return values;
}
export function nextCronTime(expression: string, after = new Date()): Date {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5 || expression.length > 200 || !Number.isFinite(after.getTime())) throw new Error('cron 需要五个字段：分 时 日 月 周');
  const minutes = field(parts[0]!,0,59), hours = field(parts[1]!,0,23);
  const days = field(parts[2]!,1,31), months = field(parts[3]!,1,12), weekdays = field(parts[4]!,0,7);
  if (weekdays.has(7)) weekdays.add(0);
  const candidate = new Date(Math.floor(after.getTime()/60_000)*60_000+60_000);
  const deadline = after.getTime() + 8 * 366 * 24 * 60 * 60_000;
  while (candidate.getTime() <= deadline) {
    const day = days.has(candidate.getDate()), weekday = weekdays.has(candidate.getDay());
    const matchesDay = parts[2]!.startsWith('*') || parts[4]!.startsWith('*') ? day && weekday : day || weekday;
    if (!months.has(candidate.getMonth()+1) || !matchesDay) {
      candidate.setDate(candidate.getDate()+1); candidate.setHours(0,0,0,0); continue;
    }
    if (hours.has(candidate.getHours()) && minutes.has(candidate.getMinutes())) return candidate;
    // Advance by elapsed minutes so repeated/skipped DST hours remain monotonic.
    candidate.setTime(candidate.getTime()+60_000);
  }
  throw new Error('cron 在未来八年内没有有效执行时间');
}
