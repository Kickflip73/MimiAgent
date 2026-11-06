import type { Tool } from '@openai/agents';
import { z } from 'zod';
import { tool } from '../tool-factory.js';
import { SpeechRenderUncertainError, SpeechVoiceUncertainError, type SpeechOutput, type SpeechStreamContext } from './speech-output.js';

export const SPEECH_TOOL_NAMES = new Set(['speech']);

export function withoutSpeechTools(tools: Tool[]): Tool[] {
  return tools.filter((candidate) => !SPEECH_TOOL_NAMES.has(candidate.name));
}

const speechParameters = z.object({
  action: z.enum(['voices', 'settings', 'configure', 'prepare', 'voice_save', 'voice_generate', 'voice_preview', 'voice_confirm', 'voice_discard', 'voice_clone', 'engine_voice', 'voice_remove', 'inspect', 'synthesize', 'play', 'speak']),
  input: z.string().max(20_000).optional()
    .describe('speech text; play: audioId/path; clone: WAV path; inspect: audioId'),
  engine: z.enum(['auto', 'macos', 'kokoro', 'breeze']).optional(),
  voice: z.string().max(120).optional()
    .describe('preset or saved:<id> from settings'),
  speed: z.number().min(0.5).max(2).optional(),
  language: z.enum(['auto', 'zh', 'en', 'ja']).optional(),
  instructions: z.string().max(2000).optional().describe('Breeze only: voice description'),
  textMode: z.enum(['readable', 'verbatim']).optional(),
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional().describe('profile id'),
  transcript: z.string().max(1000).optional().describe('voice_clone: exact spoken words in the reference WAV'),
  name: z.string().max(80).optional().describe('profile name'),
}).strict();

export function createSpeechTools(speech: SpeechOutput, streamContext?: (autoplay: boolean) => SpeechStreamContext | undefined): Tool[] {
  return [
    tool({
      name: 'speech',
      description: 'Local macos/kokoro/breeze speech; see speech-studio. settings lists defaults/voices; configure sets defaults; engine_voice selects an engine voice. prepare makes a reading script. voice_preview then voice_confirm saves after approval; voice_discard abandons; voice_remove deletes. clone needs WAV path/transcript. speak streams/autoplays; synthesize streams; play reuses audioId/path; inspect checks receipts. Busy queues, not a stuck service: never kill/restart it via Shell. Keep full stories; never shorten/replay uncertain work.',
      parameters: speechParameters,
      execute: async ({ action, input, id, name, transcript, ...options }, _context, details) => {
        try {
          if (action === 'inspect') return await speech.inspect(input);
          if (action === 'voices' || action === 'settings') return speech.catalog();
          if (action === 'voice_clone') {
            if (!input) throw new Error('需要参考 WAV 文件绝对路径');
            return await speech.cloneVoiceFile({ id, name, text: transcript }, input, details?.signal);
          }
          if (action === 'engine_voice') return speech.setEngineVoice({ engine: options.engine, voice: options.voice });
          if (action === 'configure') return speech.configure(options);
          if (action === 'voice_save') return speech.saveVoice({ id, name, options });
          if (action === 'voice_preview') {
            const preview = await speech.previewVoice({ id, name, options, text: input }, undefined, details?.signal);
            return { ...preview.audio, previewId: preview.id, name: preview.name, saved: false, playback: 'conversation' };
          }
          if (action === 'voice_confirm' || action === 'voice_discard') return await speech.manage(action, id, details?.signal);
          if (action === 'voice_generate') return await speech.generateVoice({ id, name, options, text: input }, details?.signal);
          if (action === 'voice_remove') { if (!id) throw new Error('需要音色 id'); return speech.removeVoice(id); }
          if (action === 'prepare') { if (!input) throw new Error('需要阅读原文 input'); return speech.selection(input, options); }
          if (action === 'play') {
            if (!input) throw new Error('speech play 需要 audioId 或音频绝对路径 input');
            return { ...await speech.preparePlayback(input), playback: 'conversation' };
          }
          if (input === undefined) throw new Error(`speech ${action} 需要 text input`);
          return { ...await speech.synthesize(input, options, details?.signal, streamContext?.(action === 'speak')), playback: 'conversation' };
        } catch (error) {
          if (error instanceof SpeechVoiceUncertainError) return { mimiStatus: 'action_uncertain', status: 'uncertain',
            voiceId: error.voiceId, message: error.message, retryable: false, next: 'speech settings; report the existing voice operation, do not regenerate' };
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
