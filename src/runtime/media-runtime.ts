import type { Tool } from '@openai/agents';
import { z } from 'zod';
import { tool } from '../tool-factory.js';
import type {
  ModelTarget,
  RunModelBinding,
} from '../core/model-routing.js';
import { modelTargetSchema } from '../core/model-routing.js';
import type { ModelGateway } from './model-gateway.js';
import type { ImageGenerationResult } from './providers/types.js';
import type { WorkUnitModelResolver } from './work-unit-model-resolver.js';
export { createSpeechTools } from './speech-tools.js';

export interface MediaWorkUnitInput {
  prompt: string;
  image?: string;
  size?: string;
  modelTarget?: ModelTarget;
  routeVersion: number;
  scenario?: 'image-generation.default' | 'image-editing.default';
}

export interface MediaWorkUnitResult extends ImageGenerationResult {
  kind: 'media';
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
    return { ...result, kind: 'media', binding, cost: 'unknown' };
  }
}

export interface MediaToolsOptions {
  runtime: () => MediaRuntime;
  routeVersion: () => number;
}

export function createMediaTools(options: MediaToolsOptions): Tool[] {
  return [
    tool({
      name: 'generate_image',
      description: '创建独立 Media WorkUnit 生成或编辑图片；不会伪装成 Agent 或聊天 SubAgent。',
      parameters: z.object({
        prompt: z.string().trim().min(1).max(20_000),
        image: z.string().max(20 * 1024 * 1024).optional(),
        size: z.string().trim().min(1).max(50).optional(),
        modelTarget: modelTargetSchema.optional(),
      }).strict(),
      execute: ({ prompt, image, size, modelTarget }) => options.runtime().run({
        prompt,
        ...(image ? { image } : {}),
        ...(size ? { size } : {}),
        ...(modelTarget ? { modelTarget } : {}),
        routeVersion: options.routeVersion(),
      }),
    }),
  ];
}
