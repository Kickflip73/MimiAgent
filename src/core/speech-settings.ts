import path from 'node:path';
import { z } from 'zod';
import { AtomicJsonStore } from './state-file.js';

export const speechSelectionSchema = z.object({
  engine: z.enum(['auto', 'breeze', 'kokoro', 'macos']).default('auto'),
  voice: z.string().max(120).default(''),
  speed: z.number().min(0.5).max(2).default(1),
  language: z.enum(['auto', 'zh', 'en', 'ja']).default('auto'),
  instructions: z.string().max(2000).default(''),
  textMode: z.enum(['readable', 'verbatim']).default('readable'),
}).strict();
// Overrides must preserve omitted fields so a preview uses the persisted defaults.
export const speechOverridesSchema = z.object({
  engine: speechSelectionSchema.shape.engine.removeDefault().optional(),
  voice: speechSelectionSchema.shape.voice.removeDefault().optional(),
  speed: speechSelectionSchema.shape.speed.removeDefault().optional(),
  language: speechSelectionSchema.shape.language.removeDefault().optional(),
  instructions: speechSelectionSchema.shape.instructions.removeDefault().optional(),
  textMode: speechSelectionSchema.shape.textMode.removeDefault().optional(),
}).strict();
export const speechProfileSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  name: z.string().trim().min(1).max(80),
  options: speechSelectionSchema,
  referenceId: z.string().optional(),
  sampleId: z.string().optional(),
  state: z.enum(['ready', 'generating', 'uncertain']).default('ready'),
}).strict();
const schema = z.object({ version: z.literal(1), defaults: speechSelectionSchema,
  engineVoices: z.object({ breeze: z.string().max(120).optional(), kokoro: z.string().max(120).optional(), macos: z.string().max(120).optional() }).strict().default({}),
  profiles: z.array(speechProfileSchema).max(100) }).strict();
export type SpeechSelection = z.infer<typeof speechSelectionSchema>;
export type SpeechProfile = z.infer<typeof speechProfileSchema>;
export function speechSettings(directory: string) {
  return new AtomicJsonStore(path.join(directory, 'speech-settings.json'), {
    defaultValue: () => schema.parse({ version: 1, defaults: {}, profiles: [] }),
    decode: value => schema.parse(value), preserveSchemaMismatch: true, recoverCorrupt: false,
  });
}


export const voicePreviewSchema = z.object({
  id: speechProfileSchema.shape.id, name: speechProfileSchema.shape.name,
  options: speechSelectionSchema, referenceId: z.string(), text: z.string(),
  audioId: z.string().uuid(), createdAt: z.string(),
  kind: z.enum(['description', 'clone']),
  state: z.enum(['generating', 'ready', 'saving', 'saved', 'uncertain', 'discarded']),
}).strict();
export function voicePreviews(directory: string) {
  const schema = z.object({ entries: z.record(z.string(), voicePreviewSchema) }).strict();
  return new AtomicJsonStore<z.infer<typeof schema>>(path.join(directory, 'voice-previews.json'), {
    defaultValue: () => ({ entries: {} }), decode: value => schema.parse(value),
    preserveSchemaMismatch: true, recoverCorrupt: false,
  });
}
