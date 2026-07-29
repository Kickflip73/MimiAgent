import type {
  ModelTarget,
  RunModelBinding,
} from '../core/model-routing.js';
import type { ModelGateway } from './model-gateway.js';
import type { ImageGenerationResult } from './providers/types.js';
import type { WorkUnitModelResolver } from './work-unit-model-resolver.js';

export interface MediaWorkUnitInput {
  prompt: string;
  image?: string;
  size?: string;
  modelTarget?: ModelTarget;
  routeVersion: number;
  scenario?: 'image-generation.default' | 'image-editing.default';
}

export interface MediaWorkUnitResult extends ImageGenerationResult {
  binding: RunModelBinding;
  cost: 'unknown';
}

export class MediaRuntime {
  constructor(
    private readonly gateway: ModelGateway,
    private readonly resolver: WorkUnitModelResolver,
  ) {}

  async run(input: MediaWorkUnitInput, signal?: AbortSignal): Promise<MediaWorkUnitResult> {
    const scenario = input.scenario
      ?? (input.image ? 'image-editing.default' : 'image-generation.default');
    const binding = this.resolver.resolve({
      scenario,
      profile: {
        ...(input.modelTarget ? { modelTarget: input.modelTarget } : {}),
        requirements: {
          imageOutput: true,
          ...(input.image ? { imageInput: true } : {}),
          toolCalling: false,
        },
      },
      routeVersion: input.routeVersion,
    });
    const result = await this.gateway.createImageRuntime(binding.target).generate({
      prompt: input.prompt,
      ...(input.image ? { image: input.image } : {}),
      ...(input.size ? { size: input.size } : {}),
    }, signal);
    if (!result.artifacts.length) throw new Error('图片 Runtime 未返回 artifact');
    return { ...result, binding, cost: 'unknown' };
  }
}
