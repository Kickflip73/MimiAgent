import type { AgentInputItem } from '@openai/agents';
import type { MediaTrust } from '../core/media-evidence.js';
import type { MimiAgent } from '../runtime/mimi-agent.js';
import {
  inputWithAttachments,
  type StagedAttachment,
} from '../runtime/attachments.js';
import { preflightMediaEvidenceReferences } from '../runtime/media-input-materializer.js';

export interface DaemonMediaInputAuthority {
  sessionId: string;
  profileId: string;
  workspaceId?: string;
  trust: MediaTrust;
}

export async function materializeDaemonMediaInput(input: {
  text: string;
  attachments: readonly StagedAttachment[];
  referencedMediaEvidenceIds: readonly string[];
  attachmentRoot?: string;
  agent: MimiAgent;
  authority: DaemonMediaInputAuthority;
}): Promise<AgentInputItem[]> {
  const video = input.attachments.find((attachment) => (
    attachment.kind === 'video' || attachment.mediaType.startsWith('video/')
  ));
  if (video) {
    throw new Error(`视频附件 ${video.name} 尚未生成音轨/关键帧/时间片 Evidence，当前诚实阻断`);
  }
  const invalidAudio = input.attachments.find((attachment) => (
    (attachment.kind === 'audio' || attachment.mediaType.startsWith('audio/'))
    && (attachment.kind !== 'audio' || attachment.mediaType !== 'audio/wav')
  ));
  if (invalidAudio) throw new Error(`音频附件 ${invalidAudio.name} 仅支持严格 PCM16 WAV`);
  if (input.attachments.some((attachment) => attachment.kind === 'audio')
    && !input.agent.audioTranscriber) {
    throw new Error('当前运行环境没有可用的本地文件 ASR transcriber，音频未发送给模型');
  }

  const inline = input.attachments.filter((attachment) => (
    attachment.kind === 'image' || attachment.kind === 'file'
  ));
  await preflightMediaEvidenceReferences({
    attachments: inline,
    evidenceIds: input.referencedMediaEvidenceIds,
    session: input.agent.session,
    authority: input.authority,
  });
  const materialized = await inputWithAttachments(input.text, inline, input.attachmentRoot);
  if (typeof materialized !== 'string') return materialized;
  return [{
    role: 'user',
    content: [{ type: 'input_text', text: materialized }],
  }] as AgentInputItem[];
}
