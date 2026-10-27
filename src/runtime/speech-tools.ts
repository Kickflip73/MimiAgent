import type { Tool } from '@openai/agents';
import { z } from 'zod';
import { tool } from '../tool-factory.js';
import { SPEECH_VOICES, SpeechRenderUncertainError, type SpeechOutput } from './speech-output.js';

export const SPEECH_TOOL_NAMES = new Set(['speech']);

export function withoutSpeechTools(tools: Tool[]): Tool[] {
  return tools.filter((candidate) => !SPEECH_TOOL_NAMES.has(candidate.name));
}

const speechParameters = z.object({
  action: z.enum(['voices', 'inspect', 'synthesize', 'play', 'speak']),
  input: z.string().max(20_000).optional()
    .describe('synthesize/speak: exact text; play: persisted audioId or absolute path of existing audio; inspect: optional audioId'),
  engine: z.enum(['auto', 'chattts', 'kokoro', 'breeze']).optional(),
  voice: z.enum(SPEECH_VOICES.map(voice => voice.id) as [string, ...string[]]).optional()
    .describe('voice id returned by the voices action; may change on every call'),
  speed: z.number().min(0.5).max(2).optional(),
}).strict();

export function createSpeechTools(speech: SpeechOutput): Tool[] {
  return [
    tool({
      name: 'speech',
      description: 'Conversation audio: synthesize/speak return a playable file; play reuses audioId/path without synthesis or OS playback. User controls playback; do not claim it is audible. voices lists voices; inspect reads receipts. Never duplicate uncertain renders. Read verbatim. ChatTTS max 300 chars (including auto Chinese); use audio-briefing system speech for long text, never truncate or split to bypass limits. Breeze voices (breeze:*) run on a local server and handle long text. No Shell bypass.',
      parameters: speechParameters,
      execute: async ({ action, input, ...options }, _context, details) => {
        try {
          if (action === 'inspect') return await speech.inspect(input);
          if (action === 'voices') {
            const { renderer: _renderer, playback: _playback, ...status } = speech.status();
            return { status, voices: speech.listVoices() };
          }
          if (action === 'play') {
            if (!input) throw new Error('speech play 需要 audioId 或音频绝对路径 input');
            return { ...await speech.preparePlayback(input), playback: 'conversation' };
          }
          if (input === undefined) throw new Error(`speech ${action} 需要 text input`);
          return { ...await speech.synthesize(input, options, details?.signal), playback: 'conversation' };
        } catch (error) {
          if (!(error instanceof SpeechRenderUncertainError)) throw error;
          return { mimiStatus: 'action_uncertain', status: 'uncertain', audioId: error.audio.id,
            file: error.audio.file, message: error.message,
            next: 'speech inspect once; if still unconfirmed, report the original operation instead of repeated polling or synthesis',
            retryable: false };
        }
      },
    }),
  ];
}
