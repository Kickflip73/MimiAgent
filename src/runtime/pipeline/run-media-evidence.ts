import type { ActiveRun, MimiAgent, MimiRunOptions } from '../mimi-agent.js';
import { prepareAndRegisterRunAudioEvidence } from './audio-evidence-registration.js';
import { registerRunMediaEvidence } from './media-evidence-registration.js';

/** Registers current ingress media, derives local audio facts, and returns model-safe context. */
export async function prepareRunMediaEvidence(
  host: MimiAgent,
  run: ActiveRun,
  options: MimiRunOptions | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  const sourceEventId = options?.cause?.sourceEventId ?? options?.cause?.eventId;
  await registerRunMediaEvidence({
    artifacts: host.mediaArtifacts,
    session: run.session,
    evidence: options?.mediaEvidence,
    runId: run.runId,
    sessionId: run.sessionId,
    profileId: run.scope.profileId,
    workspaceId: options?.workspaceId,
    sourceEventId,
    trust: options?.cause?.trust ?? 'owner',
  });
  const current = options?.mediaEvidence ?? [];
  run.facts.recordOriginalMediaEvidence(current);
  const audio = await prepareAndRegisterRunAudioEvidence({
    artifacts: host.mediaArtifacts,
    session: run.session,
    originalEvidence: current,
    transcriber: host.audioTranscriber,
    runId: run.runId,
    sessionId: run.sessionId,
    profileId: run.scope.profileId,
    workspaceId: options?.workspaceId,
    sourceEventId,
    trust: options?.cause?.trust ?? 'owner',
    ...(signal ? { signal } : {}),
  });
  run.facts.recordMediaEvidence(audio.evidence, audio.anchors);
  return audio.instructions;
}
