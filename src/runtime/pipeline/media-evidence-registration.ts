import type { FileSession } from '../../core/session.js';
import type { MediaEvidence, MediaTrust } from '../../core/media-evidence.js';
import {
  sessionMediaArtifactOwner,
  type MediaArtifactStore,
} from '../media-artifact-store.js';

export interface RegisterRunMediaEvidenceInput {
  artifacts: MediaArtifactStore;
  session: FileSession;
  evidence?: readonly MediaEvidence[];
  runId: string;
  sessionId: string;
  profileId: string;
  workspaceId?: string;
  sourceEventId?: string;
  trust: MediaTrust;
}

/** Keeps provenance validation and the CAS-owner/Session commit protocol together. */
export async function registerRunMediaEvidence(
  input: RegisterRunMediaEvidenceInput,
): Promise<void> {
  if (!input.evidence?.length) return;
  for (const evidence of input.evidence) {
    if (evidence.sourceRef.profileId !== input.profileId) {
      throw new Error(`MediaEvidence ${evidence.id} profile 与当前 Run 不一致`);
    }
    if (input.workspaceId && evidence.sourceRef.workspaceId !== input.workspaceId) {
      throw new Error(`MediaEvidence ${evidence.id} Workspace 与当前 Run 不一致`);
    }
    if (input.sourceEventId && evidence.sourceRef.eventId !== input.sourceEventId) {
      throw new Error(`MediaEvidence ${evidence.id} Event 与当前 Run 不一致`);
    }
    if (evidence.sourceRef.trust !== input.trust) {
      throw new Error(`MediaEvidence ${evidence.id} trust 与当前 Run 不一致`);
    }
    if (evidence.sourceRef.runId && evidence.sourceRef.runId !== input.runId) {
      throw new Error(`MediaEvidence ${evidence.id} Run 与当前 Run 不一致`);
    }
  }

  const owner = await input.artifacts.acquireEvidenceOwner(
    sessionMediaArtifactOwner(input.sessionId),
    input.evidence,
  );
  let sessionPersisted = false;
  try {
    const added = await input.session.registerMediaEvidence(input.evidence, input.runId);
    if (added === 0) {
      const existing = await Promise.all(
        input.evidence.map((item) => input.session.getMediaEvidence(item.id)),
      );
      if (existing.some((item, index) => (
        !item || JSON.stringify(item) !== JSON.stringify(input.evidence![index])
      ))) {
        throw new Error('MediaEvidence 未写入当前 active Run，拒绝提交 artifact owner');
      }
    }
    sessionPersisted = true;
    await owner.commit();
  } catch (error) {
    // After Session JSON commits, retain the lease: startup reconciliation can promote it.
    if (!sessionPersisted) await owner.rollback();
    throw error;
  }
}
