import type { TaskExecutor, TaskInput, TaskType, TaskWorkspaceAccess } from './types.js';

interface TaskRouteContract { workspaceAccess: readonly TaskWorkspaceAccess[] }

export const TASK_ROUTE_CONTRACT: Readonly<Record<TaskType, TaskRouteContract>> = {
  conversation: {
    workspaceAccess: ['none', 'read', 'write'],
  },
  background: {
    workspaceAccess: ['read', 'write'],
  },
  scheduled: {
    workspaceAccess: ['read', 'write'],
  },
  briefing: {
    workspaceAccess: ['read'],
  },
  memory_maintenance: {
    workspaceAccess: ['read'],
  },
};

const TASK_EXECUTORS = new Set<TaskExecutor>(['session_actor', 'isolated_worker', 'codex']);

export function validTaskRoute(input: {
  type: string;
  executor: string;
  workspaceAccess: string;
}): boolean {
  const contract = (TASK_ROUTE_CONTRACT as Readonly<Partial<Record<string, TaskRouteContract>>>)[input.type];
  if (!contract) return false;
  return TASK_EXECUTORS.has(input.executor as TaskExecutor)
    && (contract.workspaceAccess as readonly string[]).includes(input.workspaceAccess);
}

export function validateTaskRoute(input: Pick<TaskInput, 'type' | 'executor' | 'workspaceAccess'>): void {
  const contract = (TASK_ROUTE_CONTRACT as Readonly<Partial<Record<string, TaskRouteContract>>>)[input.type];
  if (!contract) {
    throw new Error(`不支持的 Task type=${input.type}`);
  }
  if (!TASK_EXECUTORS.has(input.executor)) throw new Error(`不支持的 Task executor=${input.executor}`);
  if (!contract.workspaceAccess.includes(input.workspaceAccess)) {
    throw new Error(
      `Task type=${input.type} 只允许 workspaceAccess=${contract.workspaceAccess.join('|')}`,
    );
  }
}
