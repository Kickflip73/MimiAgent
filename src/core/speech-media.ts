import path from 'node:path';
import { z } from 'zod';
import { toolResultObject, toolResultFailure } from './tool-result.js';

const audio = z.object({
  id: z.string().uuid(), file: z.string().max(4096),
  format: z.enum(['wav', 'mp3', 'm4a', 'ogg', 'flac']),
  engine: z.enum(['chattts', 'kokoro', 'unknown']), createdAt: z.string(),
});

/** Accept a speech receipt, never an arbitrary file mentioned in tool text. */
export function speechAudioFile(value: unknown): string | undefined {
  let record = toolResultObject(value);
  if (record?.type === 'text') record = toolResultObject(record.text);
  if (toolResultFailure(record)) return undefined;
  const parsed = audio.safeParse(record);
  if (!parsed.success || !path.isAbsolute(parsed.data.file)
    || path.extname(parsed.data.file).slice(1).toLowerCase() !== parsed.data.format) return undefined;
  return parsed.data.file;
}

export function speechHistoryFiles(items: readonly unknown[]): string[] {
  const calls = new Map<string, string>();
  const files = new Set<string>();
  for (const value of items) {
    const item = toolResultObject(value);
    if (!item) continue;
    const id = String(item.callId ?? item.call_id ?? '');
    if (!id) continue;
    if (item.type === 'function_call') {
      const args = toolResultObject(item.arguments);
      if (item.name === 'speech' && ['play', 'speak', 'synthesize'].includes(String(args?.action))) calls.set(id, 'speech');
    } else if (['function_call_result', 'function_call_output'].includes(String(item.type)) && calls.has(id)) {
      calls.delete(id);
      const file = speechAudioFile(item.output);
      if (file && item.status !== 'failed') files.add(file);
    }
  }
  return [...files];
}

export function withSpeechLinks(answer: string, files: readonly string[]): string {
  for (const file of new Set(files)) {
    const url = file.split('/').map(part => encodeURIComponent(part).replace(/[()]/g, char => '%' + char.charCodeAt(0).toString(16))).join('/');
    if (!answer.includes(`](${file})`) && !answer.includes(`](${url})`) && !answer.includes('`' + file + '`')) answer += `\n\n[语音](${url})`;
  }
  return answer;
}
