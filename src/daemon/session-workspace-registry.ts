import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AtomicJsonStore } from '../core/state-file.js';
import { resolveTaskWorkspace } from '../runtime/workspace-resolution.js';
import type { ImmutableEvent } from './types.js';

const workspaceIdSchema = z.string().regex(/^workspace:[0-9a-f-]{36}$/u);

const workspaceBindingSchema = z.object({
  id: workspaceIdSchema,
  root: z.string().min(1).max(4_096),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

const sessionBindingSchema = z.object({
  sessionId: z.string().min(1).max(200),
  workspaceId: workspaceIdSchema,
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

const registryStateSchema = z.object({
  version: z.literal(1),
  workspaces: z.array(workspaceBindingSchema).max(10_000),
  sessions: z.array(sessionBindingSchema).max(10_000),
}).strict();

type RegistryState = z.infer<typeof registryStateSchema>;

export interface SessionWorkspaceBinding {
  workspaceId: string;
  workspaceRoot: string;
  created: boolean;
}

export interface ResolveSessionEventWorkspaceInput {
  registry: SessionWorkspaceRegistry;
  event: ImmutableEvent;
  sessionId: string;
  currentWorkspaceRoot?: string;
  defaultWorkspaceRoot: string;
}

function emptyState(): RegistryState {
  return { version: 1, workspaces: [], sessions: [] };
}

async function canonicalWorkspaceRoot(workspaceRoot: string): Promise<string> {
  const selected = path.resolve(workspaceRoot);
  const info = await stat(selected);
  if (!info.isDirectory()) throw new Error(`Session 工作区不是目录：${selected}`);
  return realpath(selected);
}

function eventPayload(event: ImmutableEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {};
}

function legacyWorkspaceRoot(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error('event.payload.workspaceRoot 不能为空');
  if (!path.isAbsolute(value) || value.length > 4_096) {
    throw new Error('event.payload.workspaceRoot 必须是有界绝对路径');
  }
  return path.resolve(value);
}

/** Resolves opaque workspace bindings, retaining absolute paths only for old durable Events. */
export async function resolveSessionEventWorkspace(
  input: ResolveSessionEventWorkspaceInput,
): Promise<string> {
  if (input.event.trust !== 'owner') {
    return input.currentWorkspaceRoot ?? input.defaultWorkspaceRoot;
  }
  const payload = eventPayload(input.event);
  const workspaceId = payload.workspaceId === undefined
    ? undefined
    : workspaceIdSchema.parse(payload.workspaceId);
  const binding = await input.registry.resolve(input.sessionId, workspaceId);
  const requestedWorkspaceRoot = binding?.workspaceRoot
    ?? legacyWorkspaceRoot(workspaceId ? undefined : payload.workspaceRoot);
  return (await resolveTaskWorkspace({
    requestedWorkspaceRoot,
    sessionWorkspaceRoot: input.currentWorkspaceRoot,
    defaultWorkspaceRoot: input.defaultWorkspaceRoot,
  })).workspaceRoot;
}

/**
 * Private daemon registry mapping an opaque Event-safe id to a local path.
 * Absolute paths stay in this 0600 state file and never enter immutable Events.
 */
export class SessionWorkspaceRegistry {
  private readonly state: AtomicJsonStore<RegistryState>;

  constructor(file: string) {
    this.state = new AtomicJsonStore(file, {
      defaultValue: emptyState,
      decode: (value) => registryStateSchema.parse(value),
      pretty: false,
      preserveSchemaMismatch: true,
    });
  }

  async bind(sessionId: string, workspaceRoot: string): Promise<SessionWorkspaceBinding> {
    const root = await canonicalWorkspaceRoot(workspaceRoot);
    return this.state.update((state) => {
      const now = new Date().toISOString();
      const existing = state.sessions.find((item) => item.sessionId === sessionId);
      if (existing) {
        const current = state.workspaces.find((item) => item.id === existing.workspaceId);
        if (!current) throw new Error(`Session ${sessionId} 的 Workspace binding 已损坏`);
        if (path.resolve(current.root) !== root) {
          throw new Error(
            `Session ${sessionId} 已绑定 ${current.id}；工作区切换必须经过独立的空闲门禁`,
          );
        }
        existing.updatedAt = now;
        return { workspaceId: current.id, workspaceRoot: current.root, created: false };
      }
      let workspace = state.workspaces.find((item) => path.resolve(item.root) === root);
      if (!workspace) {
        workspace = { id: `workspace:${randomUUID()}`, root, createdAt: now };
        state.workspaces.push(workspace);
      }
      state.sessions.push({ sessionId, workspaceId: workspace.id, updatedAt: now });
      return { workspaceId: workspace.id, workspaceRoot: workspace.root, created: true };
    });
  }

  async resolve(
    sessionId: string,
    expectedWorkspaceId?: string,
  ): Promise<SessionWorkspaceBinding | undefined> {
    if (expectedWorkspaceId) workspaceIdSchema.parse(expectedWorkspaceId);
    const state = await this.state.read();
    const session = state.sessions.find((item) => item.sessionId === sessionId);
    if (!session) {
      if (expectedWorkspaceId) {
        throw new Error(`Session ${sessionId} 没有持久化 Workspace binding`);
      }
      return undefined;
    }
    if (expectedWorkspaceId && session.workspaceId !== expectedWorkspaceId) {
      throw new Error(`Event Workspace ${expectedWorkspaceId} 与 Session ${sessionId} binding 不一致`);
    }
    const workspace = state.workspaces.find((item) => item.id === session.workspaceId);
    if (!workspace) throw new Error(`Session ${sessionId} 的 Workspace binding 已损坏`);
    await canonicalWorkspaceRoot(workspace.root);
    return { workspaceId: workspace.id, workspaceRoot: workspace.root, created: false };
  }

  async release(sessionId: string, expectedWorkspaceId: string): Promise<boolean> {
    workspaceIdSchema.parse(expectedWorkspaceId);
    return this.state.update((state) => {
      const index = state.sessions.findIndex((item) => item.sessionId === sessionId);
      if (index < 0 || state.sessions[index]?.workspaceId !== expectedWorkspaceId) return false;
      state.sessions.splice(index, 1);
      if (!state.sessions.some((item) => item.workspaceId === expectedWorkspaceId)) {
        const workspaceIndex = state.workspaces.findIndex((item) => item.id === expectedWorkspaceId);
        if (workspaceIndex >= 0) state.workspaces.splice(workspaceIndex, 1);
      }
      return true;
    });
  }
}
