import { mediaEvidenceIdSchema } from '../core/media-evidence.js';
import { MAX_ATTACHMENTS } from './media-artifact-store.js';

const MEDIA_REFERENCE_FIELD = 'referencedMediaEvidenceIds';

export const MAX_MEDIA_REFERENCE_COUNT = MAX_ATTACHMENTS;

function validateMediaEvidenceIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${MEDIA_REFERENCE_FIELD} 必须是数组`);
  }
  if (value.length > MAX_MEDIA_REFERENCE_COUNT) {
    throw new Error(`媒体引用最多 ${MAX_MEDIA_REFERENCE_COUNT} 个`);
  }
  const ids = value.map((item, index) => {
    const parsed = mediaEvidenceIdSchema.safeParse(item);
    if (!parsed.success) throw new Error(`媒体引用 ${index} 格式无效`);
    return parsed.data;
  });
  if (new Set(ids).size !== ids.length) throw new Error('媒体引用不能重复');
  return ids;
}

export function mediaEvidenceIdsFromPayload(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const record = payload as Record<string, unknown>;
  if (!Object.hasOwn(record, MEDIA_REFERENCE_FIELD)) return [];
  return validateMediaEvidenceIds(record[MEDIA_REFERENCE_FIELD]);
}

export function parseMediaReferenceInput(input: string): {
  text: string;
  mediaEvidenceIds: string[];
} {
  const mediaEvidenceIds: string[] = [];
  const text = input.replace(/(^|\s)@media:(\S*)/giu, (match, boundary: string, id: string) => {
    const token = match.slice(boundary.length);
    if (!token.startsWith('@media:')) throw new Error('媒体引用格式无效');
    const parsed = mediaEvidenceIdSchema.safeParse(id);
    if (!parsed.success) throw new Error('媒体引用格式无效');
    if (mediaEvidenceIds.includes(parsed.data)) throw new Error('媒体引用不能重复');
    if (mediaEvidenceIds.length >= MAX_MEDIA_REFERENCE_COUNT) {
      throw new Error(`媒体引用最多 ${MAX_MEDIA_REFERENCE_COUNT} 个`);
    }
    mediaEvidenceIds.push(parsed.data);
    return boundary;
  }).replace(/[ \t]{2,}/g, ' ').trim();
  return { text, mediaEvidenceIds };
}
