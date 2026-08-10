import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import {
  createGeneratedImageEvidence,
  mediaEvidenceIdSchema,
  type MediaEvidence,
  type MediaTrust,
} from '../core/media-evidence.js';
import type {
  ModelTarget,
  RunModelBinding,
} from '../core/model-routing.js';
import { modelTargetSchema } from '../core/model-routing.js';
import type { FileSession } from '../core/session.js';
import { TOOL_LEDGER_ARGUMENTS } from '../core/tool-metadata.js';
import { decodeGeneratedImageArtifact } from './generated-image-artifact.js';
import {
  sessionMediaArtifactOwner,
  type MediaArtifactStore,
  type StagedAttachment,
} from './media-artifact-store.js';
import type { ModelGateway } from './model-gateway.js';
import { registerRunMediaEvidence } from './pipeline/media-evidence-registration.js';
import type { ImageGenerationResult } from './providers/types.js';
import type { WorkUnitModelResolver } from './work-unit-model-resolver.js';
export { createSpeechTools } from './speech-tools.js';

export interface MediaWorkUnitInput {
  prompt: string;
  mediaEvidenceId?: string;
  size?: string;
  modelTarget?: ModelTarget;
  routeVersion: number;
  scenario?: 'image-generation.default' | 'image-editing.default';
}

export interface MediaWorkUnitResult {
  kind: 'media';
  operation: 'generate' | 'edit';
  evidence: {
    ref: string;
    anchor: { kind: 'image'; imageOrdinal: number };
  };
  artifact: {
    ref: string;
    sha256: string;
    mimeType: string;
    bytes: number;
  };
  binding: RunModelBinding;
  requestId?: string;
  usage?: ImageGenerationResult['usage'];
  cost: 'unknown';
}

export interface MediaWorkUnitAuthority {
  artifacts: MediaArtifactStore;
  session: FileSession;
  runId: string;
  sessionId: string;
  profileId: string;
  workspaceId?: string;
  eventId?: string;
  trust: MediaTrust;
}

function evidenceAttachment(evidence: MediaEvidence): StagedAttachment {
  return {
    kind: evidence.kind,
    name: evidence.originalName,
    mediaType: evidence.mimeType,
    bytes: evidence.bytes,
    sha256: evidence.sha256,
    artifactRef: evidence.mediaRef,
    evidence,
  };
}

function assertEditableEvidence(
  evidence: MediaEvidence,
  authority: MediaWorkUnitAuthority,
): void {
  if (evidence.kind !== 'image') {
    throw new Error(`MediaEvidence ${evidence.id} 不是可编辑图片`);
  }
  if (evidence.sourceRef.sessionId !== authority.sessionId) {
    throw new Error(`MediaEvidence ${evidence.id} 不属于当前 Session`);
  }
  if (evidence.sourceRef.profileId !== authority.profileId) {
    throw new Error(`MediaEvidence ${evidence.id} profile 与当前 Run 不一致`);
  }
  if (evidence.sourceRef.workspaceId !== authority.workspaceId) {
    throw new Error(`MediaEvidence ${evidence.id} Workspace 与当前 Run 不一致`);
  }
  if (evidence.sourceRef.trust !== authority.trust) {
    throw new Error(`MediaEvidence ${evidence.id} trust 与当前 Run 不一致`);
  }
}

export class MediaRuntime {
  constructor(
    private readonly gateway: ModelGateway,
    private readonly resolver: WorkUnitModelResolver,
    private readonly currentRun: () => MediaWorkUnitAuthority | undefined,
  ) {}

  async run(input: MediaWorkUnitInput, signal?: AbortSignal): Promise<MediaWorkUnitResult> {
    const authority = this.currentRun();
    if (!authority) throw new Error('当前没有可绑定的 Media WorkUnit Run');
    const sourceEvidence = input.mediaEvidenceId
      ? await authority.session.getMediaEvidence(input.mediaEvidenceId)
      : undefined;
    if (input.mediaEvidenceId && !sourceEvidence) {
      throw new Error(`当前 Session 不存在 MediaEvidence：${input.mediaEvidenceId}`);
    }

    let image: string | undefined;
    if (sourceEvidence) {
      assertEditableEvidence(sourceEvidence, authority);
      const bytes = await authority.artifacts.read(evidenceAttachment(sourceEvidence));
      image = `data:${sourceEvidence.mimeType};base64,${bytes.toString('base64')}`;
    }

    const scenario = input.scenario
      ?? (image ? 'image-editing.default' : 'image-generation.default');
    const binding = this.resolver.resolve({
      scenario,
      profile: {
        ...(input.modelTarget ? { modelTarget: input.modelTarget } : {}),
        requirements: {
          imageOutput: true,
          ...(image ? { imageInput: true } : {}),
          toolCalling: false,
        },
      },
      routeVersion: input.routeVersion,
    });
    const providerResult = await this.gateway.createImageRuntime(binding.target).generate({
      prompt: input.prompt,
      ...(image ? { image } : {}),
      ...(input.size ? { size: input.size } : {}),
    }, signal);
    const decoded = decodeGeneratedImageArtifact(providerResult.artifacts);
    const batch = await authority.artifacts.stageGeneratedImage({
      data: decoded.bytes,
      mediaType: decoded.mediaType,
      originalName: decoded.originalName,
    });
    const attachment = batch.attachments[0];
    if (!attachment) {
      await batch.rollback();
      throw new Error('生成图片 staging 未返回 artifact');
    }
    const evidence = createGeneratedImageEvidence({
      attachment,
      binding,
      runId: authority.runId,
      sessionId: authority.sessionId,
      profileId: authority.profileId,
      ...(authority.workspaceId ? { workspaceId: authority.workspaceId } : {}),
      ...(authority.eventId ? { eventId: authority.eventId } : {}),
      trust: authority.trust,
      occurredAt: new Date().toISOString(),
      ...(sourceEvidence ? { inputEvidenceIds: [sourceEvidence.id] } : {}),
    });
    try {
      await registerRunMediaEvidence({
        artifacts: authority.artifacts,
        session: authority.session,
        evidence: [evidence],
        runId: authority.runId,
        sessionId: authority.sessionId,
        profileId: authority.profileId,
        ...(authority.workspaceId ? { workspaceId: authority.workspaceId } : {}),
        ...(authority.eventId ? { sourceEventId: authority.eventId } : {}),
        trust: authority.trust,
      });
      // The Session owner is already durable; this idempotent promotion removes the
      // unbound crash claim without inventing an immutable Event reference.
      await batch.commit(sessionMediaArtifactOwner(authority.sessionId));
    } catch (error) {
      try {
        await batch.rollback();
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          '生成图片 Evidence 持久化失败且 staging rollback 未完成',
        );
      }
      throw error;
    }
    const usage = providerResult.usage && (
      providerResult.usage.inputTokens !== undefined
      || providerResult.usage.outputTokens !== undefined
    ) ? {
        ...(providerResult.usage.inputTokens !== undefined
          ? { inputTokens: providerResult.usage.inputTokens }
          : {}),
        ...(providerResult.usage.outputTokens !== undefined
          ? { outputTokens: providerResult.usage.outputTokens }
          : {}),
      } : undefined;
    return {
      kind: 'media',
      operation: sourceEvidence ? 'edit' : 'generate',
      evidence: {
        ref: evidence.id,
        anchor: { kind: 'image', imageOrdinal: evidence.imageOrdinal! },
      },
      artifact: {
        ref: evidence.mediaRef,
        sha256: evidence.sha256,
        mimeType: evidence.mimeType,
        bytes: evidence.bytes,
      },
      binding,
      ...(providerResult.requestId ? { requestId: providerResult.requestId } : {}),
      ...(usage ? { usage } : {}),
      cost: 'unknown',
    };
  }
}

const mediaToolParameters = z.object({
  prompt: z.string().trim().min(1).max(20_000),
  mediaEvidenceId: mediaEvidenceIdSchema.optional(),
  size: z.string().trim().min(1).max(50).optional(),
  modelTarget: modelTargetSchema.optional(),
}).strict();

type LedgerAwareMediaTool = Tool & {
  [TOOL_LEDGER_ARGUMENTS]?: (rawInput: string) => string;
};

function canonicalMediaToolArguments(rawInput: string): string {
  return JSON.stringify(mediaToolParameters.parse(JSON.parse(rawInput) as unknown));
}

export interface MediaToolsOptions {
  runtime: () => MediaRuntime;
  routeVersion: () => number;
}

export function createMediaTools(options: MediaToolsOptions): Tool[] {
  const mediaTool = tool({
    name: 'generate_image',
    description: '创建独立 Media WorkUnit 生成图片，或用当前 Session 的 mediaEvidenceId 编辑原图；输入输出均只持久化稳定引用。',
    parameters: mediaToolParameters,
    execute: ({ prompt, mediaEvidenceId, size, modelTarget }, _context, details) => {
      if (!details?.toolCall?.callId) throw new Error('Media WorkUnit 缺少 tool callId');
      return options.runtime().run({
        prompt,
        ...(mediaEvidenceId ? { mediaEvidenceId } : {}),
        ...(size ? { size } : {}),
        ...(modelTarget ? { modelTarget } : {}),
        routeVersion: options.routeVersion(),
      }, details.signal);
    },
  }) as LedgerAwareMediaTool;
  // Parse and canonicalize before the side-effect ledger opens a record. Legacy raw
  // `image`/data URL arguments therefore fail without ever becoming durable JSON.
  mediaTool[TOOL_LEDGER_ARGUMENTS] = canonicalMediaToolArguments;
  return [mediaTool];
}
