import process from 'node:process';
import type { MimiHost } from '../runtime/mimi-host.js';
import type { MimiLiveEvents } from './live-events.js';
import type { MimiStore } from './store.js';
import { backgroundTaskSummary, inspectBackgroundTaskSummary } from './task-tools.js';
import type { TaskProgressLog } from './task-progress-log.js';
import type { TaskProcessSupervisor } from './task-supervisor.js';

type StoredTask = ReturnType<MimiStore['getTask']>;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createTaskRuntimeInspection(context: {
  host: MimiHost;
  liveEvents: MimiLiveEvents;
  progressLog: TaskProgressLog;
  supervisor: TaskProcessSupervisor;
}) {
  const summary = (task: StoredTask) => {
    if (!task) throw new Error('后台任务不存在');
    const worker = context.supervisor.status().find((candidate) => candidate.taskId === task.id);
    return { ...backgroundTaskSummary(task), ...(worker ? { worker } : {}) };
  };
  const details = async (task: StoredTask) => {
    if (!task) throw new Error('后台任务不存在');
    const taskSummary = task.executor === 'codex'
      ? { ...await inspectBackgroundTaskSummary(task), worker: summary(task).worker }
      : summary(task);
    const recentEvents = context.liveEvents.recent(task.id, 8);
    const progress = task.executor === 'isolated_worker'
      ? await context.progressLog.inspect(task.id).catch((error) => {
          process.stderr.write(`[MimiAgent] cannot inspect task progress ${task.id}: ${message(error)}\n`);
          return undefined;
        })
      : undefined;
    const snapshot = task.executor !== 'codex' && task.sessionKey
      ? await context.host.snapshot(task.sessionKey).catch(() => undefined)
      : undefined;
    return {
      ...taskSummary,
      ...(progress ? { progress } : {}),
      ...(recentEvents.length ? { recentEvents } : {}),
      ...(snapshot?.plan.length ? { plan: snapshot.plan } : {}),
      ...(snapshot?.recovery ? { checkpoint: snapshot.recovery } : {}),
    };
  };
  return { summary, details };
}
