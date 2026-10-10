import { sanitizeSensitiveData } from '../core/data-sanitizer.js';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/** Read only the selected durable attempt, independent of the live stream buffer. */
export async function executionHistory(database: DatabaseSync, dataRoot: string, runId?: string, sessionId?: string) {
  const row = runId
    ? database.prepare('SELECT * FROM runs WHERE id = ?').get(runId)
    : database.prepare('SELECT * FROM runs WHERE session_key = ? ORDER BY started_at DESC LIMIT 1').get(sessionId ?? '');
  if (!row) { if (!runId) return null; throw new Error('执行记录不存在'); }
  const session = String(row.session_key);
  if (!/^[\w.:-]+$/.test(session)) throw new Error('无效的执行会话');
  const startedAt = String(row.started_at), completedAt = row.completed_at ? String(row.completed_at) : undefined;
  const steps: Record<string, unknown>[] = [];
  let truncated = false;
  for (const suffix of ['.1.jsonl', '.jsonl']) {
    const input = createReadStream(path.join(dataRoot, 'traces', session + suffix), { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.sessionId !== session || event.timestamp < startedAt || completedAt && event.timestamp > completedAt) continue;
        const data = event.data ?? {};
        if (event.type === 'status') steps.push({ ...data, kind: 'status', timestamp: event.timestamp, fullDetail: data.detail ?? '', next: data.next ?? '' });
        else if (['turn_start','turn_interrupted','run_finalization'].includes(event.type)) steps.push({ kind:'status', tone:'agent', title: {turn_start:'开始执行',turn_interrupted:'执行中断',run_finalization:'交付检查'}[event.type as string], timestamp:event.timestamp, fullDetail: JSON.stringify(data,null,2) });
        if (steps.length >= 4000) { truncated = true; break; }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    finally { lines.close(); input.destroy(); }
    if (truncated) break;
  }
  let answer: string | undefined;
  if (typeof row.answer_json === 'string') {
    try { const result = sanitizeSensitiveData(JSON.parse(row.answer_json)); answer = typeof result === 'string' ? result : typeof result?.answer === 'string' ? result.answer : undefined; } catch { /* Older malformed receipts remain inspectable through their trace. */ }
  }
  return { answer, runId: String(row.id), taskId: row.task_id, sessionId: session, startedAt, completedAt, status: row.status, error: row.error, steps, truncated };
}
