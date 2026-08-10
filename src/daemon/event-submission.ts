import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { assertSessionId } from '../core/session-id.js';
import {
  stageAttachmentBatch,
  validateLocalAttachmentSubmission,
} from '../runtime/attachments.js';
import {
  MAX_MEDIA_REFERENCE_COUNT,
  mediaEvidenceIdsFromPayload,
} from '../runtime/media-reference-request.js';
import { eventKindSchema, eventTrustSchema, type EventEnvelope } from './types.js';
import type { MimiStore } from './store.js';
import type { SessionWorkspaceRegistry } from './session-workspace-registry.js';
import {
  parseRequestedLocalRunPolicy,
  parseRequestedSecurityProfile,
} from './local-run-policy.js';

interface SubmitParams extends Partial<Pick<EventEnvelope,
  'externalId' | 'source' | 'trust' | 'priority' | 'profileId' | 'sessionKey'
  | 'actor' | 'conversation' | 'replyRoute'>> {
  eventId?: string;
  text?: string;
  payload?: unknown;
  kind?: EventEnvelope['kind'];
  workspaceRoot?: string;
  resumeState?: boolean;
  approvedPersonalMessageText?: string;
  attachments?: unknown;
  referencedMediaEvidenceIds?: unknown;
  requestedRunPolicy?: unknown;
  requestedSecurityProfile?: unknown;
}

type IngestResult = ReturnType<MimiStore['ingestEvent']>;

export interface SubmitDaemonEventOptions {
  defaultWorkspaceRoot: string;
  attachmentRoot: string;
  store: MimiStore;
  workspaceRegistry: SessionWorkspaceRegistry;
  ingestOwnerPrompt: (event: EventEnvelope, prompt: string) => IngestResult;
}

function paramsObject(value: unknown): SubmitParams {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('RPC 参数必须是对象');
  }
  return value as SubmitParams;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 不能为空`);
  return value.trim();
}

function optionalAbsoluteDirectory(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  const selected = requiredString(value, name);
  if (!path.isAbsolute(selected)) throw new Error(`${name} 必须是绝对路径`);
  if (selected.length > 4_096) throw new Error(`${name} 过长`);
  return path.resolve(selected);
}

/**
 * Validates and atomically joins local attachment staging with durable Event ingestion.
 * A durable Event keeps its claim if ref publication fails; startup reconciliation can
 * promote that lease without ever leaving the Event pointing at a missing blob.
 */
export async function submitDaemonEvent(
  rawParams: unknown,
  options: SubmitDaemonEventOptions,
): Promise<IngestResult> {
  const params = paramsObject(rawParams);
  const now = new Date().toISOString();
  const source = params.source ?? 'local-cli';
  const trust = eventTrustSchema.parse(params.trust ?? 'owner');
  const eventId = params.eventId ? requiredString(params.eventId, 'eventId') : randomUUID();
  const profileId = params.profileId ?? 'owner';
  const sessionKey = params.sessionKey === undefined
    ? undefined
    : assertSessionId(requiredString(params.sessionKey, 'sessionKey'));
  const payloadRecord = params.payload && typeof params.payload === 'object'
    && !Array.isArray(params.payload)
    ? params.payload as Record<string, unknown>
    : undefined;
  if (payloadRecord && Object.hasOwn(payloadRecord, 'requestedRunPolicy')) {
    throw new Error('payload.requestedRunPolicy 是保留字段；必须通过认证 local-cli 提交参数设置');
  }
  if (payloadRecord && Object.hasOwn(payloadRecord, 'requestedSecurityProfile')) {
    throw new Error('payload.requestedSecurityProfile 是保留字段；必须通过认证 local-cli 提交参数设置');
  }
  if (payloadRecord && Object.hasOwn(payloadRecord, 'referencedMediaEvidenceIds')) {
    throw new Error('payload.referencedMediaEvidenceIds 是保留字段；必须通过认证 local-cli 提交参数设置');
  }
  const requestedRunPolicy = parseRequestedLocalRunPolicy(params.requestedRunPolicy);
  const requestedSecurityProfile = parseRequestedSecurityProfile(params.requestedSecurityProfile);
  if (requestedRunPolicy && (source !== 'local-cli' || trust !== 'owner')) {
    throw new Error('requestedRunPolicy 仅允许认证 local-cli owner 收窄本轮权限');
  }
  if (requestedRunPolicy && !sessionKey) {
    throw new Error('requestedRunPolicy 需要显式 Session 绑定');
  }
  if (requestedSecurityProfile && (source !== 'local-cli' || trust !== 'owner')) {
    throw new Error('requestedSecurityProfile 仅允许认证 local-cli owner 收窄本轮权限');
  }
  if (requestedSecurityProfile && !sessionKey) {
    throw new Error('requestedSecurityProfile 需要显式 Session 绑定');
  }
  const requestedAttachments = validateLocalAttachmentSubmission({
    source,
    trust,
    payload: params.payload,
    attachments: params.attachments,
  });
  const hasRequestedMediaReferences = Object.hasOwn(params, 'referencedMediaEvidenceIds');
  const referencedMediaEvidenceIds = hasRequestedMediaReferences
    ? mediaEvidenceIdsFromPayload({
        referencedMediaEvidenceIds: params.referencedMediaEvidenceIds,
      })
    : [];
  if (hasRequestedMediaReferences && (source !== 'local-cli' || trust !== 'owner')) {
    throw new Error('只有 local-cli owner 输入可以提交媒体引用');
  }
  if (hasRequestedMediaReferences && !sessionKey) {
    throw new Error('媒体引用需要显式 Session 绑定');
  }
  if (hasRequestedMediaReferences && params.payload !== undefined) {
    throw new Error('显式 payload 不能与媒体引用同时提交');
  }
  if ((requestedAttachments?.length ?? 0) + referencedMediaEvidenceIds.length
    > MAX_MEDIA_REFERENCE_COUNT) {
    throw new Error(`附件与媒体引用合计最多 ${MAX_MEDIA_REFERENCE_COUNT} 个`);
  }
  const prompt = params.payload === undefined ? requiredString(params.text, 'text') : undefined;
  const eventKind = eventKindSchema.parse(params.kind ?? 'command');
  const requestedWorkspaceRoot = source === 'local-cli' && trust === 'owner'
    ? optionalAbsoluteDirectory(params.workspaceRoot, 'workspaceRoot')
    : undefined;
  if (source === 'local-cli' && trust === 'owner' && sessionKey
    && params.payload !== undefined
    && (!params.payload || typeof params.payload !== 'object' || Array.isArray(params.payload))) {
    throw new Error('local-cli owner 的显式 payload 必须是对象才能绑定 Workspace');
  }

  let attachmentBatch: Awaited<ReturnType<typeof stageAttachmentBatch>> | undefined;
  let workspaceBinding: Awaited<ReturnType<SessionWorkspaceRegistry['bind']>> | undefined;
  let eventPersisted = false;
  try {
    workspaceBinding = source === 'local-cli' && trust === 'owner' && sessionKey
      ? requestedWorkspaceRoot
        ? await options.workspaceRegistry.bind(sessionKey, requestedWorkspaceRoot)
        : await options.workspaceRegistry.resolve(sessionKey)
          ?? await options.workspaceRegistry.bind(sessionKey, options.defaultWorkspaceRoot)
      : undefined;
    attachmentBatch = requestedAttachments?.length
      ? await stageAttachmentBatch(
          requestedAttachments,
          workspaceBinding?.workspaceRoot ?? options.defaultWorkspaceRoot,
          options.attachmentRoot,
          {
            profileId,
            ...(workspaceBinding ? { workspaceId: workspaceBinding.workspaceId } : {}),
            ...(sessionKey ? { sessionId: sessionKey } : {}),
            eventId,
            sourceId: eventId,
            trust,
            occurredAt: now,
          },
        )
      : undefined;
    const stagedAttachments = attachmentBatch?.attachments ?? [];
    const submittedPayload = params.payload ?? {
      ...(params.resumeState === true ? { resumeState: true } : {}),
      ...(typeof params.approvedPersonalMessageText === 'string'
        && params.approvedPersonalMessageText.trim()
        ? { approvedPersonalMessageText: params.approvedPersonalMessageText.trim().slice(0, 4_000) }
        : {}),
      ...(stagedAttachments.length ? { attachments: stagedAttachments } : {}),
      ...(referencedMediaEvidenceIds.length ? { referencedMediaEvidenceIds } : {}),
    };
    const basePayload = requestedRunPolicy || requestedSecurityProfile
      ? {
          ...(submittedPayload as Record<string, unknown>),
          ...(requestedRunPolicy ? { requestedRunPolicy } : {}),
          ...(requestedSecurityProfile ? { requestedSecurityProfile } : {}),
        }
      : submittedPayload;
    const payload = workspaceBinding
      ? {
          ...(basePayload && typeof basePayload === 'object' && !Array.isArray(basePayload)
            ? basePayload as Record<string, unknown>
            : {}),
          workspaceId: workspaceBinding.workspaceId,
        }
      : basePayload;
    const event: EventEnvelope = {
      id: eventId,
      externalId: params.externalId ?? randomUUID(),
      source,
      kind: eventKind,
      trust,
      payload,
      occurredAt: now,
      receivedAt: now,
      priority: Math.max(0, Math.min(100, params.priority ?? 100)),
      profileId,
      sessionKey,
      actor: params.actor,
      conversation: params.conversation,
      replyRoute: params.replyRoute,
    };
    const accepted = prompt !== undefined && source === 'local-cli' && trust === 'owner'
      ? options.ingestOwnerPrompt(event, prompt)
      : options.store.ingestEvent(event);
    if (accepted.inserted) {
      eventPersisted = true;
      await attachmentBatch?.commit({ kind: 'event', id: eventId });
    } else {
      await attachmentBatch?.rollback();
      if (workspaceBinding?.created && sessionKey) {
        await options.workspaceRegistry.release(sessionKey, workspaceBinding.workspaceId);
      }
    }
    return accepted;
  } catch (error) {
    if (!eventPersisted) {
      await attachmentBatch?.rollback();
      if (workspaceBinding?.created && sessionKey) {
        await options.workspaceRegistry.release(sessionKey, workspaceBinding.workspaceId);
      }
    }
    throw error;
  }
}
