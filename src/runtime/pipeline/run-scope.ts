import { randomUUID } from 'node:crypto';
import type {
  AgentPermissionMode,
  SecurityProfile,
} from '../../config.js';
import type { AgentMode } from '../instructions.js';
import type { RunModelBinding } from '../../core/model-routing.js';
import type { ProviderTransport } from '../../core/model-routing.js';

export interface RunScopeCause {
  eventId: string;
  taskId?: string;
  profileId?: string;
  source: string;
  actor?: string;
  conversation?: string;
  trust: 'owner' | 'trusted' | 'external' | 'public' | 'system';
  personId?: string;
  personName?: string;
}

export interface RunScope {
  readonly runId: string;
  readonly ownerId: string;
  readonly sessionId: string;
  readonly profileId: string;
  readonly workspaceRoot: string;
  readonly provider: string;
  readonly transport?: ProviderTransport;
  readonly model: string;
  readonly modelBinding?: Readonly<RunModelBinding>;
  readonly mode: AgentMode;
  readonly permissionMode: AgentPermissionMode;
  readonly securityProfile: SecurityProfile;
  readonly input: string;
  readonly cause?: Readonly<RunScopeCause>;
  readonly executionKey?: string;
}

export interface RunScopeInput {
  sessionId: string;
  workspaceRoot: string;
  provider: string;
  transport?: ProviderTransport;
  model: string;
  modelBinding?: RunModelBinding;
  mode: AgentMode;
  permissionMode: AgentPermissionMode;
  securityProfile: SecurityProfile;
  input: string;
  options?: {
    cause?: RunScopeCause;
    executionKey?: string;
  };
}

export function captureRunScope(input: RunScopeInput): RunScope {
  const cause = input.options?.cause
    ? Object.freeze({ ...input.options.cause })
    : undefined;
  return Object.freeze({
    runId: randomUUID(),
    ownerId: randomUUID(),
    sessionId: input.sessionId,
    profileId: cause?.profileId ?? 'owner',
    workspaceRoot: input.workspaceRoot,
    provider: input.provider,
    transport: input.transport,
    model: input.model,
    modelBinding: input.modelBinding
      ? Object.freeze({
          ...input.modelBinding,
          target: Object.freeze({ ...input.modelBinding.target }),
        })
      : undefined,
    mode: input.mode,
    permissionMode: input.permissionMode,
    securityProfile: input.securityProfile,
    input: input.input,
    cause,
    executionKey: input.options?.executionKey,
  });
}
