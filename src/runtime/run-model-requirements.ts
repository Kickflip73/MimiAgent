import type { AgentInputItem } from '@openai/agents';
import type { ModelRequirements, WorkUnitModelProfile } from '../core/model-routing.js';
import { containsFileInput } from './providers/file-input.js';

export interface RunModelRequirementOptions {
  modelProfile?: WorkUnitModelProfile;
  referencedMediaEvidenceIds?: readonly string[];
}

export function containsImageInput(input: string | AgentInputItem[]): boolean {
  if (typeof input === 'string') return false;
  return input.some((item) => {
    const value = item as unknown as Record<string, unknown>;
    if (!Array.isArray(value.content)) return false;
    return value.content.some((part) => (
      Boolean(part)
      && typeof part === 'object'
      && (part as Record<string, unknown>).type === 'input_image'
    ));
  });
}

export function freezeRunModelRequirements(
  input: string | AgentInputItem[],
  options?: RunModelRequirementOptions,
): Readonly<ModelRequirements> {
  return Object.freeze({
    ...options?.modelProfile?.requirements,
    ...(containsImageInput(input) || options?.referencedMediaEvidenceIds?.length
      ? { imageInput: true }
      : {}),
    ...(containsFileInput(input) ? { fileInput: true } : {}),
    toolCalling: options?.modelProfile?.requirements?.imageOutput ? false : true,
  });
}
