import type { TaskExecutor, TaskInput, TaskType, TaskWorkspaceAccess } from './types.js';

interface TaskRouteContract {
  executors: readonly TaskExecutor[];
  workspaceAccess: readonly TaskWorkspaceAccess[];
}

export const TASK_ROUTE_CONTRACT: Readonly<Record<TaskType, TaskRouteContract>> = {
  conversation: {
    executors: ['session_actor'],
    workspaceAccess: ['none', 'read', 'write'],
  },
  background: {
    executors: ['isolated_worker', 'codex'],
    workspaceAccess: ['read', 'write'],
  },
  scheduled: {
    executors: ['isolated_worker'],
    workspaceAccess: ['read', 'write'],
  },
  briefing: {
    executors: ['isolated_worker'],
    workspaceAccess: ['read'],
  },
  memory_maintenance: {
    executors: ['isolated_worker'],
    workspaceAccess: ['read'],
  },
};

export function validTaskRoute(input: Pick<TaskInput, 'type' | 'executor' | 'workspaceAccess'>): boolean {
  const contract = (TASK_ROUTE_CONTRACT as Readonly<Partial<Record<string, TaskRouteContract>>>)[input.type];
  if (!contract) return false;
  return contract.executors.includes(input.executor)
    && contract.workspaceAccess.includes(input.workspaceAccess);
}

export function validateTaskRoute(input: Pick<TaskInput, 'type' | 'executor' | 'workspaceAccess'>): void {
  const contract = (TASK_ROUTE_CONTRACT as Readonly<Partial<Record<string, TaskRouteContract>>>)[input.type];
  if (!contract) {
    throw new Error(`不支持的 Task type=${input.type}`);
  }
  if (!contract.executors.includes(input.executor)) {
    throw new Error(`Task type=${input.type} 只允许 executor=${contract.executors.join('|')}`);
  }
  if (!contract.workspaceAccess.includes(input.workspaceAccess)) {
    throw new Error(
      `Task type=${input.type} 只允许 workspaceAccess=${contract.workspaceAccess.join('|')}`,
    );
  }
}
