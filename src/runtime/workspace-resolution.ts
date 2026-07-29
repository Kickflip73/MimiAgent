import { stat } from 'node:fs/promises';
import path from 'node:path';

export type WorkspaceResolutionSource =
  | 'requested-workspace'
  | 'session'
  | 'runtime-default';

export interface WorkspaceResolution {
  workspaceRoot: string;
  source: WorkspaceResolutionSource;
  created: false;
}

export interface WorkspaceResolutionInput {
  requestedWorkspaceRoot?: string;
  sessionWorkspaceRoot?: string;
  defaultWorkspaceRoot: string;
}

async function existingDirectory(value: string, field: string): Promise<string> {
  const resolved = path.resolve(value);
  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new Error(`${field} 不存在：${resolved}`);
  }
  if (!info.isDirectory()) throw new Error(`${field} 不是目录：${resolved}`);
  return resolved;
}

/**
 * Workspace selection is a structured Host decision. Owner prose is deliberately
 * absent from this boundary: the CLI/request payload, existing Session binding,
 * and runtime default are the only sources allowed to change filesystem scope.
 */
export async function resolveTaskWorkspace(
  request: WorkspaceResolutionInput,
): Promise<WorkspaceResolution> {
  if (request.requestedWorkspaceRoot) {
    return {
      workspaceRoot: await existingDirectory(request.requestedWorkspaceRoot, '请求工作区'),
      source: 'requested-workspace',
      created: false,
    };
  }
  if (request.sessionWorkspaceRoot) {
    return {
      workspaceRoot: await existingDirectory(request.sessionWorkspaceRoot, 'Session 工作区'),
      source: 'session',
      created: false,
    };
  }
  return {
    workspaceRoot: await existingDirectory(request.defaultWorkspaceRoot, 'Runtime 默认工作区'),
    source: 'runtime-default',
    created: false,
  };
}
