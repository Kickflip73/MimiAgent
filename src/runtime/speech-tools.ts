import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import type { SpeechOutput } from './speech-output.js';

export const SPEECH_TOOL_NAMES = new Set(['speech']);

export function withoutSpeechTools(tools: Tool[]): Tool[] {
  return tools.filter((candidate) => !SPEECH_TOOL_NAMES.has(candidate.name));
}

const speechParameters = z.object({
  action: z.enum(['voices', 'synthesize', 'play', 'speak']),
  input: z.string().max(20_000).optional(),
  engine: z.enum(['auto', 'chattts', 'kokoro']).optional(),
  voice: z.string().trim().min(1).max(80).optional(),
  speed: z.number().min(0.5).max(2).optional(),
}).strict();

export function createSpeechTools(speech: SpeechOutput): Tool[] {
  return [
    tool({
      name: 'speech',
      description: 'Speech: voices lists voices; for other actions input is exact text or audioId. synthesize makes WAV; play plays; speak makes and plays.',
      parameters: speechParameters,
      execute: ({ action, input, ...options }, _context, details) => {
        if (action === 'voices') return { status: speech.status(), voices: speech.listVoices() };
        if (action === 'play') {
          if (!input) throw new Error('speech play 需要 audioId input');
          return speech.play(input, details?.signal);
        }
        if (input === undefined) throw new Error(`speech ${action} 需要 text input`);
        return action === 'synthesize'
          ? speech.synthesize(input, options, details?.signal)
          : speech.speak(input, options, details?.signal);
      },
    }),
  ];
}
