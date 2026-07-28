import {
  sanitizeSensitiveData,
  sanitizeSensitiveText,
} from '../core/data-sanitizer.js';
import {
  boundedMemoryEvidenceSnapshot,
  type BoundedMemoryEvidenceSnapshot,
} from './persistence/memory-evidence.js';

export function sanitizedMemoryEvidenceSnapshot(
  objective: unknown,
  result: unknown,
  error?: string,
): BoundedMemoryEvidenceSnapshot {
  return boundedMemoryEvidenceSnapshot(
    sanitizeSensitiveData(objective),
    sanitizeSensitiveData(result),
    sanitizeSensitiveText(error),
  );
}
