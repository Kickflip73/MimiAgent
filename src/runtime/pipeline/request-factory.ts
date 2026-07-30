import { Agent, type Tool } from '@openai/agents';
import type { ReasoningIntent } from '../../core/model-routing.js';
import type { AgentModel } from '../model.js';

export interface AgentRequestInput {
  model: AgentModel;
  instructions: string;
  tools: Tool[];
  outputReserve: number;
  focusedOutputLimit?: number;
  reasoning?: ReasoningIntent;
}

export interface PreparedAgentRequest {
  agent: Agent;
  maxTokens: number;
  toolNames: readonly string[];
}

export class AgentRequestFactory {
  create(input: AgentRequestInput): PreparedAgentRequest {
    const maxTokens = input.focusedOutputLimit === undefined
      ? input.outputReserve
      : Math.min(input.outputReserve, input.focusedOutputLimit);
    const agent = new Agent({
      name: 'MimiAgent',
      model: input.model,
      modelSettings: {
        maxTokens,
        ...(input.reasoning === 'high'
          ? { reasoning: { effort: 'high' as const } }
          : input.reasoning === 'off'
            ? { reasoning: { effort: 'none' as const } }
            : {}),
      },
      instructions: input.instructions,
      tools: input.tools,
    });
    return {
      agent,
      maxTokens,
      toolNames: Object.freeze(input.tools.map((tool) => tool.name)),
    };
  }
}
