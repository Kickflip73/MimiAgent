import { speechSettings, voicePreviews, voicePreviewSchema, speechSelectionSchema, speechOverridesSchema, speechProfileSchema } from '../core/speech-settings.js';
import { validateVoiceSample } from './speech-voice-sample.js';
import { prepareSpeechText } from './speech-text.js';
import { assertSessionId } from '../core/session-id.js';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdir, open, realpath, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AtomicJsonStore } from '../core/state-file.js';
import { runManagedCommand } from '../core/managed-process.js';
import { PRE_MIMI_DATA_DIRECTORY } from '../core/mimi-legacy.js';
import { BREEZE_DEFAULT_BASE_URL, BreezeTtsClient } from './breeze-tts.js';
import type { TtsConfig } from '../config.js';

export type SpeechEngine = 'auto' | 'macos' | 'kokoro' | 'breeze';
export type SpeechLanguage = 'auto' | 'zh' | 'en' | 'ja';

export interface SpeechVoice {
  id: string;
  engine: Exclude<SpeechEngine, 'auto'>;
  language: Exclude<SpeechLanguage, 'auto'>;
  label: string;
  gender?: 'female' | 'male';
  /** Breeze only: voice-design instruction sent to the local server. */
  instructions?: string;
}

export interface SpeechSynthesisOptions {
  engine?: SpeechEngine;
  voice?: string;
  language?: SpeechLanguage;
  speed?: number;
  instructions?: string;
  textMode?: 'readable' | 'verbatim';
}

export interface SpeechAudio {
  id: string;
  file: string;
  format: 'wav' | 'm4a' | 'mp3' | 'aiff' | 'flac' | 'ogg';
  engine: Exclude<SpeechEngine, 'auto'> | 'chattts' | 'unknown';
  voice?: string;
  language: SpeechLanguage;
  createdAt: string;
}

const audioSchema = z.object({
  id: z.string().uuid(), file: z.string(), format: z.literal('wav'),
  engine: z.enum(['macos', 'chattts', 'kokoro', 'breeze']), voice: z.string().optional(),
  language: z.enum(['auto', 'zh', 'en', 'ja']), createdAt: z.string(),
}).strict();
const renderSchema = z.object({
  status: z.enum(['started', 'ready', 'uncertain']), audio: audioSchema,
  owner: z.object({ sessionId: z.string().min(1).max(200), runId: z.string().min(1).max(200) }).strict().optional(),
  streamReady: z.boolean().optional(),
  error: z.string().max(2_000).optional(),
}).strict();
const rendersSchema = z.object({ version: z.literal(1), entries: z.record(z.string(), renderSchema) }).strict();
type RenderRecord = z.infer<typeof renderSchema>;

export class SpeechRenderUncertainError extends Error {
  constructor(readonly audio: SpeechAudio, message: string) { super(message); }
}

export class SpeechVoiceUncertainError extends Error {
  constructor(readonly voiceId: string, message: string) { super(message); }
}

export interface SpeechStreamContext {
  sessionId: string;
  runId: string;
  onReady: (audioId: string) => Promise<void>;
}

type ValidatedSpeechOptions = Required<Pick<
  SpeechSynthesisOptions,
  'engine' | 'language' | 'speed'
>> & Pick<SpeechSynthesisOptions, 'voice'>;

type ResolvedSpeechOptions = Omit<ValidatedSpeechOptions, 'engine' | 'language'> & {
  engine: Exclude<SpeechEngine, 'auto'>;
  language: Exclude<SpeechLanguage, 'auto'>;
};

export interface SpeechOutputStatus {
  enabled: boolean;
  renderer: string;
  playback: string;
  voices: number;
  queuedPlayback: number;
  lastError?: string;
}

export const SPEECH_VOICES: readonly SpeechVoice[] = Object.freeze(([
  { id: 'macos:Tingting', engine: 'macos', language: 'zh', label: 'macOS 婷婷', gender: 'female' },
  { id: 'macos:Meijia', engine: 'macos', language: 'zh', label: 'macOS 美佳', gender: 'female' },
  { id: 'macos:Samantha', engine: 'macos', language: 'en', label: 'macOS Samantha', gender: 'female' },
  { id: 'macos:Kyoko', engine: 'macos', language: 'ja', label: 'macOS Kyoko', gender: 'female' },
  { id: 'zf_xiaoxiao', engine: 'kokoro', language: 'zh', label: 'Kokoro Xiaoxiao', gender: 'female' },
  { id: 'zf_xiaoyi', engine: 'kokoro', language: 'zh', label: 'Kokoro Xiaoyi', gender: 'female' },
  { id: 'zm_yunjian', engine: 'kokoro', language: 'zh', label: 'Kokoro Yunjian', gender: 'male' },
  { id: 'zm_yunyang', engine: 'kokoro', language: 'zh', label: 'Kokoro Yunyang', gender: 'male' },
  { id: 'am_echo', engine: 'kokoro', language: 'en', label: 'Kokoro Echo', gender: 'male' },
  {
    id: 'breeze:zh-narrator', engine: 'breeze', language: 'zh', label: 'Breeze 中文旁白', gender: 'female',
    instructions: '一位沉稳温暖的中文女声，吐字清晰，语速适中，语气自然，适合长篇旁白。',
  },
  {
    id: 'breeze:zh-lively', engine: 'breeze', language: 'zh', label: 'Breeze 中文活泼女声', gender: 'female',
    instructions: '一位轻快、亲切的中文年轻女声，语调有起伏，表达富有感染力。',
  },
  {
    id: 'breeze:zh-male', engine: 'breeze', language: 'zh', label: 'Breeze 中文男声', gender: 'male',
    instructions: '一位低沉、克制的中文男声，语速偏慢，句中停顿干净，适合解说。',
  },
  {
    id: 'breeze:en-narrator', engine: 'breeze', language: 'en', label: 'Breeze English Narrator', gender: 'female',
    instructions: 'A warm, thoughtful young woman with a clear, calm delivery. Natural pacing, no theatrics.',
  },
  {
    id: 'breeze:en-warm', engine: 'breeze', language: 'en', label: 'Breeze English Conversational', gender: 'male',
    instructions: 'A relaxed, friendly male voice speaking conversationally, lightly animated and close-miked.',
  },
] satisfies SpeechVoice[]).map((voice) => Object.freeze(voice)));

interface CommandResult {
  stdout: string;
  stderr: string;
}

export type SpeechCommandRunner = (
  command: string,
  args: readonly string[],
  options: { environment?: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal },
) => Promise<CommandResult>;

function validateOptions(options: SpeechSynthesisOptions): ValidatedSpeechOptions {
  let engine = options.engine ?? 'auto';
  let language = options.language ?? 'auto';
  const speed = options.speed ?? 1;
  if (!['auto', 'macos', 'kokoro', 'breeze'].includes(engine)) throw new Error(`未知 TTS 引擎：${engine}`);
  if (!['auto', 'zh', 'en', 'ja'].includes(language)) throw new Error(`未知 TTS 语言：${language}`);
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) {
    throw new Error('TTS 语速必须在 0.5 到 2 之间');
  }
  const voice = options.voice?.trim();
  if (voice) {
    const catalogVoice = SPEECH_VOICES.find((candidate) => candidate.id === voice);
    if (!catalogVoice) throw new Error(`未知 TTS 音色：${voice}`);
    const voiceEngine = catalogVoice.engine;
    if (engine !== 'auto' && engine !== voiceEngine) {
      throw new Error(`音色 ${voice} 不属于 ${engine} 引擎`);
    }
    if (engine === 'auto') engine = voiceEngine;
    if (language === 'auto' && catalogVoice) language = catalogVoice.language;
  }
  return { engine, language, speed, ...(voice ? { voice } : {}) };
}

function detectedLanguage(text: string): Exclude<SpeechLanguage, 'auto'> {
  if (/[\u3040-\u30ff\u31f0-\u31ff]/u.test(text)) return 'ja';
  if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(text)) return 'zh';
  return 'en';
}

function resolveOptions(
  text: string,
  options: ValidatedSpeechOptions,
  breezeConfigured: boolean,
): ResolvedSpeechOptions {
  const language = options.language === 'auto' ? detectedLanguage(text) : options.language;
  const engine = options.engine === 'auto'
    ? breezeConfigured ? 'breeze' : process.platform === 'darwin' ? 'macos' : 'kokoro'
    : options.engine;
  return { ...options, engine, language };
}

function voiceInstructions(voice?: string): string | undefined {
  if (!voice) return undefined;
  return SPEECH_VOICES.find((candidate) => candidate.id === voice)?.instructions;
}

function actualEngine(stdout: string, requested: SpeechEngine): Exclude<SpeechEngine, 'auto'> {
  const detected = [...stdout.matchAll(/\bengine=([^\s]+)\b/g)].at(-1)?.[1];
  if (detected && detected !== requested) throw new Error(`渲染器返回了非请求引擎：${detected}`);
  if (requested === 'auto') throw new Error('必须先解析语音引擎');
  return requested;
}

function actualVoice(stdout: string, requested?: string): string | undefined {
  const matches = [...stdout.matchAll(/\bvoice=([^\s]+)\b/g)];
  return matches.at(-1)?.[1] ?? requested;
}

export class SpeechOutput {
  private enabled: boolean;
  private readonly settings;
  private readonly previews;
  private playbackTail = Promise.resolve();
  private queuedPlayback = 0;
  private lastError?: string;
  private readonly renders: AtomicJsonStore<z.infer<typeof rendersSchema>>;

  constructor(
    private readonly config: TtsConfig,
    private readonly outputDirectory: string,
    private readonly commandRunner: SpeechCommandRunner = runManagedCommand,
    private readonly breeze: BreezeTtsClient = new BreezeTtsClient(
      config.breezeUrl ?? BREEZE_DEFAULT_BASE_URL,
    ),
  ) {
    this.enabled = config.enabled;
    this.settings = speechSettings(outputDirectory);
    this.previews = voicePreviews(outputDirectory);
    this.renders = new AtomicJsonStore(path.join(outputDirectory, 'renders.json'), {
      defaultValue: () => ({ version: 1, entries: {} }), decode: (value) => rendersSchema.parse(value),
      preserveSchemaMismatch: true, recoverCorrupt: false,
    });
  }

  async catalog() {
    const state = await this.settings.read();
    return { ...state, voices: this.listVoices(), engines: [
      { id: 'breeze', label: 'BreezeBlue MLX', configured: Boolean(this.config.breezeUrl), streaming: true, descriptionVoice: true, savedReference: true, maxChars: 10000 },
      { id: 'kokoro', label: 'Kokoro', configured: await access(this.config.command, fsConstants.X_OK).then(() => true, () => false), streaming: false, descriptionVoice: false, savedReference: false, maxChars: 20000 },
      { id: 'macos', label: 'macOS 原生语音', configured: process.platform === 'darwin', streaming: false, descriptionVoice: false, savedReference: false, maxChars: 20000 },
    ] };
  }

  async configure(value: unknown) {
    const options = speechSelectionSchema.parse(value);
    if (!Object.prototype.hasOwnProperty.call(value, 'voice') && options.engine !== 'auto') {
      options.voice = (await this.settings.read()).engineVoices[options.engine] || '';
    }
    const selected = await this.selection('测试', options);
    await this.settings.update(state => {
      state.defaults = options;
      state.engineVoices[selected.engine] = options.voice;
    });
    return this.catalog();
  }

  async setEngineVoice(value: unknown) {
    const input = z.object({ engine: z.enum(['breeze', 'kokoro', 'macos']), voice: z.string().max(120) }).strict().parse(value);
    await this.selection('测试', { ...input, instructions: '' });
    await this.settings.update(state => {
      state.engineVoices[input.engine] = input.voice;
      const engine = state.defaults.engine === 'auto'
        ? state.profiles.find(p => `saved:${p.id}` === state.defaults.voice)?.options.engine
          || SPEECH_VOICES.find(v => v.id === state.defaults.voice)?.engine
          || (this.config.breezeUrl ? 'breeze' : process.platform === 'darwin' ? 'macos' : 'kokoro')
        : state.defaults.engine;
      if (engine === input.engine) { state.defaults.voice = input.voice; state.defaults.instructions = ''; }
    });
    return this.catalog();
  }

  private previewFile(id: string, reference = false) {
    speechProfileSchema.shape.id.parse(id);
    return path.join(this.outputDirectory, `preview-${id}${reference ? '-reference' : ''}.wav`);
  }

  async previewVoice(value: unknown, audio?: Buffer, signal?: AbortSignal) {
    this.assertEnabled();
    const input = z.object({ id: speechProfileSchema.shape.id, name: speechProfileSchema.shape.name,
      text: z.string().trim().min(1).max(audio ? 1000 : 80), options: speechSelectionSchema }).strict().parse(value);
    if (input.options.engine !== 'breeze' || input.options.voice.startsWith('saved:')) throw new Error('预览需要 Breeze 描述或参考录音');
    if (audio) validateVoiceSample(audio);
    else if (!input.options.instructions.trim()) throw new Error('请填写音色描述');
    signal?.throwIfAborted();
    const preview = voicePreviewSchema.parse({ ...input, kind: audio ? 'clone' : 'description',
      referenceId: `mimi_${randomUUID().replaceAll('-', '')}`, audioId: randomUUID(), createdAt: new Date().toISOString(), state: 'generating' });
    await this.previews.update(state => {
      if (state.entries[input.id]) throw new Error('预览操作已存在，请检查原操作，不要重复生成');
      if (Object.values(state.entries).filter(p => p.state === 'ready' || p.state === 'generating').length >= 100) throw new Error('未处理预览过多，请先放弃旧预览');
      state.entries[input.id] = preview;
    });
    try {
      await mkdir(this.outputDirectory, { recursive: true, mode: 0o700 });
      if (audio) await writeFile(this.previewFile(input.id, true), audio, { mode: 0o600, flag: 'wx' });
      await this.breeze.synthesizeToFile({ text: audio ? '你好，我是咪咪。愿我的声音让每一次交流都自然、清晰。' : input.text,
        ...(audio ? { referenceAudio: { audio, text: input.text } } : { instructions: input.options.instructions }),
        speed: 1, timeoutMs: this.config.synthesisTimeoutMs, signal }, this.previewFile(input.id));
      await this.previews.update(state => {
        const entry = state.entries[input.id];
        if (entry?.state !== 'generating') throw new Error('预览操作所有权已变化');
        entry.state = 'ready';
      });
      return { id: input.id, name: input.name, state: 'ready', saved: false, audio: {
        id: preview.audioId, file: this.previewFile(input.id), format: 'wav', engine: 'breeze', createdAt: preview.createdAt } };
    } catch (error) {
      await this.previews.update(state => { if (state.entries[input.id]?.state === 'generating') state.entries[input.id]!.state = 'uncertain'; });
      throw new SpeechVoiceUncertainError(input.id, `预览未完成，未加入音色列表：${(error as Error).message}`);
    }
  }

  async previewAudio(id: string) {
    speechProfileSchema.shape.id.parse(id);
    const preview = (await this.previews.read()).entries[id];
    if (!preview || !['ready', 'saved'].includes(preview.state)) throw new Error('预览不存在或尚未就绪');
    return readFile(await this.existingAudioFile(this.previewFile(id), true));
  }

  async confirmVoice(id: string, signal?: AbortSignal) {
    speechProfileSchema.shape.id.parse(id);
    const preview = await this.previews.updateWhen(state => {
      const entry = state.entries[id];
      if (!entry) throw new Error('预览不存在');
      if (entry.state === 'saved') return { result: entry, changed: false };
      if (entry.state !== 'ready') throw new Error('预览未就绪或保存结果未确认，请检查原操作');
      entry.state = 'saving'; return { result: entry, changed: true };
    });
    if (preview.state === 'saved') return this.catalog();
    try {
      if ((await this.settings.read()).profiles.some(p => p.id === id)) throw new Error('音色 ID 已存在');
      const file = await this.existingAudioFile(this.previewFile(id, preview.kind === 'clone'), true);
      await this.breeze.registerVoice(preview.referenceId, file, preview.text, signal);
      await this.settings.update(state => {
        if (state.profiles.some(p => p.id === id)) throw new Error('音色 ID 已存在');
        if (state.profiles.length >= 100) throw new Error('最多保存 100 个音色');
        state.profiles.push({ id, name: preview.name, options: preview.options, referenceId: preview.referenceId, state: 'ready' });
      });
      await this.previews.update(state => { state.entries[id]!.state = 'saved'; });
      return this.catalog();
    } catch (error) {
      await this.previews.update(state => { if (state.entries[id]?.state === 'saving') state.entries[id]!.state = 'uncertain'; });
      throw new SpeechVoiceUncertainError(id, `保存结果未确认，请检查原操作，不要重新保存：${(error as Error).message}`);
    }
  }

  async discardVoicePreview(id: string) {
    speechProfileSchema.shape.id.parse(id);
    await this.previews.update(state => {
      const entry = state.entries[id];
      if (!entry || entry.state === 'discarded' || entry.state === 'saved') return;
      if (entry.state === 'generating' || entry.state === 'saving') throw new Error('预览操作进行中，暂时不能放弃');
      entry.state = 'discarded';
    });
    const entry = (await this.previews.read()).entries[id];
    if (entry?.state === 'discarded') {
      await Promise.all([this.previewFile(id), this.previewFile(id, true)].map(file => unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; })));
    }
    return { discarded: true };
  }

  async cloneVoice(value: unknown, audio: Buffer, signal?: AbortSignal) {
    this.assertEnabled();
    const input = z.object({ id: speechProfileSchema.shape.id, name: speechProfileSchema.shape.name,
      text: z.string().trim().min(1).max(1000) }).strict().parse(value);
    validateVoiceSample(audio);
    signal?.throwIfAborted();
    const referenceId = `mimi_${randomUUID().replaceAll('-', '')}`;
    await this.settings.update(state => {
      if (state.profiles.some(p => p.id === input.id)) throw new Error('音色 ID 已存在');
      if (state.profiles.length >= 100) throw new Error('最多保存 100 个音色');
      state.profiles.push({ id: input.id, name: input.name,
        options: speechSelectionSchema.parse({ engine: 'breeze' }), referenceId, state: 'generating' });
    });
    try {
      await this.breeze.registerVoiceAudio(referenceId, audio, input.text, signal);
      await this.settings.update(state => {
        const profile = state.profiles.find(p => p.id === input.id);
        if (profile?.referenceId !== referenceId || profile.state !== 'generating') throw new Error('音色操作所有权已变化');
        profile.state = 'ready';
      });
      return this.catalog();
    } catch (error) {
      await this.settings.update(state => {
        const profile = state.profiles.find(p => p.id === input.id);
        if (profile?.referenceId === referenceId) profile.state = 'uncertain';
      });
      throw new SpeechVoiceUncertainError(input.id, `音色保存结果未确认，请检查原记录，不要重复提交：${(error as Error).message}`);
    }
  }

  async cloneVoiceFile(value: unknown, file: string, signal?: AbortSignal) {
    const resolved = await this.existingAudioFile(file, false);
    if ((await stat(resolved)).size > 16 * 1024 * 1024) throw new Error('参考音频不能超过 16 MB');
    return this.cloneVoice(value, await readFile(resolved), signal);
  }

  async saveVoice(value: unknown) {
    const profile = speechProfileSchema.omit({ referenceId: true, sampleId: true, state: true }).parse(value);
    if (profile.options.voice.startsWith('saved:')) throw new Error('保存音色不能引用另一个保存音色');
    const selected = await this.selection('测试', profile.options);
    profile.options.engine = selected.engine;
    await this.settings.update(state => {
      if (state.profiles.some(p => p.id === profile.id)) throw new Error('音色 ID 已存在，请使用新的 ID');
      if (state.profiles.length >= 100) throw new Error('最多保存 100 个音色');
      state.profiles.push({ ...profile, state: 'ready' });
    });
    return this.catalog();
  }

  async removeVoice(id: string) {
    await this.settings.update(state => {
      const entry = state.profiles.find(p => p.id === id);
      if (!entry) throw new Error('音色不存在');
      if (entry.state === 'generating') throw new Error('音色正在生成，不能删除');
      state.profiles = state.profiles.filter(p => p.id !== id);
      if (state.defaults.voice === `saved:${id}`) { state.defaults.voice = ''; state.defaults.instructions = ''; }
      for (const engine of ['breeze', 'kokoro', 'macos'] as const) {
        if (state.engineVoices[engine] === `saved:${id}`) delete state.engineVoices[engine];
      }
    });
    return this.catalog();
  }

  async generateVoice(value: unknown, signal?: AbortSignal) {
    this.assertEnabled();
    const input = z.object({ id: speechProfileSchema.shape.id, name: speechProfileSchema.shape.name,
      options: speechSelectionSchema, text: z.string().trim().min(1).max(80) }).strict().parse(value);
    if (input.options.voice.startsWith('saved:')) throw new Error('生成新音色请使用预设音色或新的描述');
    const selected = await this.selection(input.text, input.options);
    if (selected.engine !== 'breeze') throw new Error('只有 BreezeBlue 支持生成并固定描述式音色');
    if (!selected.instructions) throw new Error('请提供音色描述或选择 Breeze 预设');
    const referenceId = `mimi_${randomUUID().replaceAll('-', '')}`;
    // Claim before either remote side effect. An uncertain attempt is never silently replayed.
    await this.settings.update(state => {
      if (state.profiles.some(p => p.id === input.id)) throw new Error('音色 ID 已存在');
      if (state.profiles.length >= 100) throw new Error('最多保存 100 个音色');
      state.profiles.push({ id: input.id, name: input.name, options: { ...input.options, engine: 'breeze' },
        referenceId, state: 'generating' });
    });
    try {
      const audio = await this.synthesize(selected.text, { ...input.options, engine: 'breeze', speed: 1, textMode: 'verbatim' }, signal);
      await this.breeze.registerVoice(referenceId, audio.file, selected.text, signal);
      await this.settings.update(state => {
        const profile = state.profiles.find(p => p.id === input.id);
        if (!profile || profile.state !== 'generating' || profile.referenceId !== referenceId) throw new Error('音色操作所有权已变化');
        profile.sampleId = audio.id; profile.state = 'ready';
      });
      return { ...await this.catalog(), sample: audio };
    } catch (error) {
      await this.settings.update(state => {
        const profile = state.profiles.find(p => p.id === input.id);
        if (profile?.referenceId === referenceId) profile.state = 'uncertain';
      });
      throw new SpeechVoiceUncertainError(input.id, `音色生成结果未确认（${input.id}）；请检查设置中的记录，不要自动重复生成：${(error as Error).message}`);
    }
  }

  async manage(action: string, value: unknown, signal?: AbortSignal): Promise<unknown> {
    if (action === 'settings' || action === 'voices') return this.catalog();
    if (action === 'configure') return this.configure(value);
    if (action === 'engine_voice') return this.setEngineVoice(value);
    if (action === 'voice_save') return this.saveVoice(value);
    if (action === 'voice_preview') return this.previewVoice(value, undefined, signal);
    if (action === 'voice_confirm') return this.confirmVoice(speechProfileSchema.shape.id.parse(value), signal);
    if (action === 'voice_discard') return this.discardVoicePreview(speechProfileSchema.shape.id.parse(value));
    if (action === 'voice_generate') return this.generateVoice(value, signal);
    if (action === 'voice_remove') return this.removeVoice(speechProfileSchema.shape.id.parse(value));
    if (action === 'prepare') {
      const input = z.object({ text: z.string().min(1).max(20000), options: speechOverridesSchema.optional() }).strict().parse(value);
      return this.selection(input.text, input.options);
    }
    throw new Error('未知语音操作');
  }

  async selection(text: string, overrides: SpeechSynthesisOptions = {}) {
    const state = await this.settings.read();
    const base = { ...state.defaults,
      ...(overrides.engine && overrides.engine !== state.defaults.engine ? { voice: overrides.engine === 'auto' ? '' : state.engineVoices[overrides.engine] || '', instructions: '' } : {}),
      ...(overrides.voice && overrides.voice !== state.defaults.voice ? { engine: 'auto', instructions: '' } : {}), ...overrides };
    const profile = base.voice?.startsWith('saved:') ? state.profiles.find(p => `saved:${p.id}` === base.voice) : undefined;
    if (base.voice?.startsWith('saved:') && (!profile || profile.state !== 'ready')) throw new Error('保存的音色不存在或尚未就绪');
    if (profile && overrides.engine && overrides.engine !== 'auto' && overrides.engine !== profile.options.engine) throw new Error('保存音色不属于所选引擎');
    const options = speechSelectionSchema.parse(profile ? { ...base, ...profile.options, ...overrides,
      engine: profile.options.engine, voice: profile.options.voice,
      speed: overrides.speed ?? state.defaults.speed, textMode: overrides.textMode ?? state.defaults.textMode } : base);
    if (options.instructions && options.engine === 'auto' && !options.voice) options.engine = 'breeze';
    const selected = resolveOptions(text, validateOptions(options), Boolean(this.config.breezeUrl));
    if (options.instructions && selected.engine !== 'breeze') throw new Error('该引擎不支持描述式音色，请选择已有音色，或切换 Breeze');
    const prepared = options.textMode === 'readable' ? prepareSpeechText(text, selected.language) : { text, language: selected.language, warnings: [] };
    return { ...selected, textMode: options.textMode, text: prepared.text, warnings: prepared.warnings,
      // A saved reference fixes the speaker. Its creation description is metadata,
      // not a request to edit that speaker again on every read-aloud.
      instructions: profile?.referenceId ? undefined
        : options.instructions || voiceInstructions(selected.voice) || this.config.breezeDefaultInstruction,
      referenceId: profile?.referenceId };
  }

  async stream(text: string, options: SpeechSynthesisOptions, signal: AbortSignal) {
    this.assertEnabled();
    const selected = await this.selection(text, options);
    if (selected.engine !== 'breeze') {
      const audio = await this.synthesize(text, options, signal);
      return new Response(await import('node:fs/promises').then(fs => fs.readFile(audio.file)), { headers: { 'content-type': 'audio/wav' } });
    }
    if (!selected.text.trim() || [...selected.text].length > 10000) throw new Error('阅读稿需要 1～10000 个字符');
    return this.breeze.stream({ text: selected.text, instructions: selected.instructions,
      voiceId: selected.referenceId, speed: selected.speed, timeoutMs: this.config.synthesisTimeoutMs, signal });
  }

  listVoices(): SpeechVoice[] {
    return SPEECH_VOICES.map((voice) => ({ ...voice }));
  }

  status(): SpeechOutputStatus {
    return {
      enabled: this.enabled,
      renderer: this.config.breezeUrl ? `breeze ${this.config.breezeUrl}` : this.config.command,
      playback: this.config.playbackCommand,
      voices: SPEECH_VOICES.length,
      queuedPlayback: this.queuedPlayback,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  async setEnabled(enabled: boolean): Promise<SpeechOutputStatus> {
    if (enabled) {
      const selected = await this.selection('测试');
      if (selected.engine === 'breeze') await this.assertBreezeAvailable();
      else if (selected.engine === 'macos') await access('/usr/bin/say', fsConstants.X_OK);
      else await this.assertCommandsAvailable(false);
    }
    this.enabled = enabled;
    if (enabled) this.lastError = undefined;
    return this.status();
  }

  private async assertBreezeAvailable(): Promise<void> {
    const health = await this.breeze.health();
    if (!health.ok) throw new Error(`Breeze TTS 服务未就绪：${this.breeze.baseUrl}`);
  }

  async synthesize(
    text: string,
    options: SpeechSynthesisOptions = {},
    signal?: AbortSignal,
    stream?: SpeechStreamContext,
  ): Promise<SpeechAudio> {
    this.assertEnabled();
    if (!text.trim()) throw new Error('TTS 文本不能为空');
    if (text.length > 20_000) throw new Error('单次 TTS 文本不能超过 20000 个字符');
    signal?.throwIfAborted();
    if (stream) assertSessionId(stream.sessionId);
    const selected = await this.selection(text, options);
    text = selected.text;
    if (!text.trim()) throw new Error('阅读稿不能为空');
    const maxChars = selected.engine === 'breeze' ? 10000 : 20000;
    if ([...text].length > maxChars) throw new Error(`阅读稿不能超过 ${maxChars} 个字符`);
    if (selected.engine === 'kokoro') await this.assertCommandsAvailable(false);
    if (selected.engine === 'macos') await access('/usr/bin/say', fsConstants.X_OK);
    await mkdir(this.outputDirectory, { recursive: true, mode: 0o700 });
    const renderer = selected.engine === 'breeze' ? this.breeze.baseUrl : selected.engine === 'macos' ? '/usr/bin/say' : this.config.command;
    const fingerprint = createHash('sha256').update(JSON.stringify({ text, selected, renderer })).digest('hex');
    const id = randomUUID();
    const input = path.join(this.outputDirectory, `.${id}.txt`);
    const output = path.join(this.outputDirectory, `${id}.wav`);
    const proposed: RenderRecord = { status: 'started', ...(stream ? { owner: { sessionId: stream.sessionId, runId: stream.runId } } : {}), audio: {
      id, file: output, format: 'wav', engine: selected.engine, language: selected.language,
      ...(selected.voice ? { voice: selected.voice } : {}), createdAt: new Date().toISOString(),
    } };
    const claimed = await this.renders.updateWhen((state) => {
      const existing = state.entries[fingerprint];
      if (existing) return { result: existing, changed: false };
      state.entries[fingerprint] = proposed;
      return { result: proposed, changed: true };
    });
    if (claimed.audio.id !== id) {
      if (claimed.status === 'ready') {
        await this.existingAudioFile(claimed.audio.file, true);
        return { ...claimed.audio };
      }
      throw new SpeechRenderUncertainError(claimed.audio,
        '同一内容和音色已有未确认的生成操作；先 inspect 该 audioId，不要重复合成或更换引擎启动副本。');
    }
    try {
      let renderedEngine: Exclude<SpeechEngine, 'auto'>;
      let renderedVoice = selected.voice;
      if (selected.engine === 'breeze') {
        const instructions = selected.instructions;
        await this.breeze.synthesizeToFile({
          text, speed: selected.speed, voiceId: selected.referenceId,
          ...(instructions ? { instructions } : {}),
          timeoutMs: this.config.synthesisTimeoutMs,
          ...(signal ? { signal } : {}),
          ...(stream ? { onAudioReady: async () => {
            signal?.throwIfAborted();
            await this.renders.update(state => {
              const entry = state.entries[fingerprint];
              if (entry?.audio.id !== id || entry.owner?.runId !== stream.runId || entry.status !== 'started') throw new Error('语音生成操作所有权已变化');
              entry.streamReady = true;
            });
            await stream.onReady(id);
          } } : {}),
        }, output);
        renderedEngine = 'breeze';
      } else if (selected.engine === 'macos') {
        await writeFile(input, text, { encoding: 'utf8', mode: 0o600 });
        renderedVoice = selected.voice || `macos:${{ zh: 'Tingting', en: 'Samantha', ja: 'Kyoko' }[selected.language]}`;
        await this.commandRunner('/usr/bin/say', ['-v', renderedVoice.slice(6), '-r', String(Math.round(175 * selected.speed)),
          '--file-format=WAVE', '--data-format=LEI16@24000', '-f', input, '-o', output],
        { timeoutMs: this.config.synthesisTimeoutMs, signal });
        renderedEngine = 'macos';
      } else {
        await writeFile(input, text, { encoding: 'utf8', mode: 0o600 });
        const result = await this.commandRunner(
          this.config.command,
          [input, '--no-play', output],
          {
            timeoutMs: this.config.synthesisTimeoutMs,
            signal,
            environment: {
              ...process.env,
              MIMI_TTS_ENGINE: selected.engine,
              MIMI_TTS_LANGUAGE: selected.language,
              MIMI_TTS_SPEED: String(selected.speed),
              MIMI_TTS_VOICE: selected.voice ?? '',
            },
          },
        );
        renderedEngine = actualEngine(result.stdout, selected.engine);
        renderedVoice = actualVoice(result.stdout, selected.voice);
      }
      const info = await stat(output);
      if (!info.isFile() || info.size === 0) throw new Error('TTS 渲染器未生成有效 WAV 文件');
      await chmod(output, 0o600);
      const audio: SpeechAudio = {
        id,
        file: output,
        format: 'wav',
        engine: renderedEngine,
        ...(renderedVoice ? { voice: renderedVoice } : {}),
        language: selected.language,
        createdAt: new Date().toISOString(),
      };
      await this.renders.update((state) => {
        const entry = state.entries[fingerprint];
        if (entry?.audio.id !== id) throw new Error('语音生成操作所有权已变化');
        state.entries[fingerprint] = { ...entry, status: 'ready', audio: audioSchema.parse(audio) };
      });
      this.lastError = undefined;
      return { ...audio };
    } catch (error) {
      this.rememberError(error);
      await this.renders.update((state) => {
        if (state.entries[fingerprint]?.audio.id === id) state.entries[fingerprint] = {
          ...state.entries[fingerprint]!, status: 'uncertain', error: this.lastError?.slice(0, 2_000) };
      });
      throw new SpeechRenderUncertainError(proposed.audio,
        `${this.lastError}；生成结果尚未确认，文件可能稍后到达。先 inspect ${id}，不要自动重新生成。`);
    } finally {
      await unlink(input).catch(() => undefined);
    }
  }

  /** Tail the original render, never synthesize again. Session ownership replaces final-history authorization while a tool is running. */
  async live(sessionId: string, audioId: string, signal: AbortSignal): Promise<Response> {
    this.assertEnabled(); assertSessionId(sessionId); z.string().uuid().parse(audioId);
    const find = async () => Object.values((await this.renders.read()).entries).find(entry => entry.audio.id === audioId);
    const entry = await find();
    if (!entry?.streamReady || entry.owner?.sessionId !== sessionId || entry.audio.engine !== 'breeze') throw new Error('当前会话没有此语音流');
    if (entry.status === 'uncertain') throw new Error('语音合成中断或结果未确认，不会重新合成');
    const file = await this.existingAudioFile(entry.audio.file, true);
    const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let offset = 44, closed = false;
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const close = async () => { if (!closed) { closed = true; controller.abort(); await handle.close(); } };
    const abort = () => { void close(); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { await close(); signal.throwIfAborted(); }
    const readEntry = find;
    let lastProgress = Date.now();
    const idleTimeout = this.config.synthesisTimeoutMs + 10000;
    const body = new ReadableStream<Uint8Array>({
      async pull(destination) {
        try {
          while (true) {
            combined.throwIfAborted();
            const buffer = Buffer.alloc(32 * 1024);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
            if (bytesRead) { lastProgress = Date.now(); offset += bytesRead; destination.enqueue(buffer.subarray(0, bytesRead)); return; }
            const current = await readEntry();
            if (!current || current.status === 'uncertain') throw new Error('语音合成中断，部分音频未完成');
            if (current.status === 'ready') {
              // The writer may have appended between our EOF read and its ready commit.
              if ((await handle.stat()).size > offset) continue;
              if (offset <= 44 || (offset - 44) % 2) throw new Error('语音流不完整');
              destination.close(); await close(); return;
            }
            if (Date.now() - lastProgress > idleTimeout) throw new Error('语音长时间没有生成进展；请检查原操作，不要缩短原文或重复合成');
            await delay(40, undefined, { signal: combined });
          }
        } catch (error) { destination.error(error); await close(); }
        finally { if (closed) signal.removeEventListener('abort', abort); }
      },
      async cancel() { await close(); signal.removeEventListener('abort', abort); },
    });
    return new Response(body, { headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '24000', 'x-sample-format': 's16le' } });
  }

  play(audio: SpeechAudio | string, signal?: AbortSignal): Promise<SpeechAudio> {
    this.assertEnabled();
    const previous = this.playbackTail;
    this.queuedPlayback += 1;
    const playback = previous.then(async () => {
      this.assertEnabled();
      signal?.throwIfAborted();
      const selected = await this.resolveAudio(audio);
      await access(selected.file, fsConstants.R_OK);
      await this.commandRunner(this.config.playbackCommand, [selected.file], {
        timeoutMs: this.config.playbackTimeoutMs,
        signal,
      });
      this.lastError = undefined;
      return { ...selected };
    }).catch((error) => {
      this.rememberError(error);
      throw error;
    }).finally(() => {
      this.queuedPlayback = Math.max(0, this.queuedPlayback - 1);
    });
    this.playbackTail = playback.then(() => undefined, () => undefined);
    return playback;
  }

  async inspect(id?: string) {
    const entries = Object.values((await this.renders.read()).entries);
    const selected = id ? entries.filter((entry) => entry.audio.id === id) : entries.slice(-20);
    return Promise.all(selected.map(async (entry) => ({ ...entry,
      fileExists: await stat(entry.audio.file).then((info) => info.isFile() && info.size > 0).catch(() => false),
      retryable: false,
      next: entry.status === 'ready' ? 'play existing audioId or file; do not synthesize again'
        : 'This is the local receipt, not a live backend job query. Report the original audioId and unconfirmed status; do not loop over unchanged receipts or regenerate. File existence alone does not confirm completion.',
    })));
  }

  /** Validate and return an audio receipt for an interactive conversation player. */
  async preparePlayback(audio: SpeechAudio | string): Promise<SpeechAudio> {
    this.assertEnabled();
    return this.resolveAudio(audio);
  }

  private async resolveAudio(audio: SpeechAudio | string): Promise<SpeechAudio> {
    if (typeof audio !== 'string') return this.resolveAudio(audio.id);
    const entries = Object.values((await this.renders.read()).entries);
    const recorded = entries.find((entry) => entry.audio.id === audio || entry.audio.file === audio);
    if (recorded) {
      if (recorded.status !== 'ready') throw new SpeechRenderUncertainError(recorded.audio, '音频生成尚未确认，先 inspect 同一操作。');
      await this.existingAudioFile(recorded.audio.file, true);
      return recorded.audio;
    }
    if (!path.isAbsolute(audio)) throw new Error(`TTS 音频不存在：${audio}`);
    const file = await this.existingAudioFile(audio, false);
    const info = await stat(file);
    return { id: randomUUID(), file, format: path.extname(file).slice(1) as SpeechAudio['format'],
      engine: 'unknown', language: 'auto', createdAt: info.mtime.toISOString() };
  }

  private async existingAudioFile(file: string, registered: boolean): Promise<string> {
    const resolved = await realpath(file);
    const info = await stat(resolved);
    if (!info.isFile() || info.size === 0) throw new Error('音频文件不存在或为空');
    if (!registered && (resolved.split(path.sep).some((part) => part === '.mimi-agent' || part === PRE_MIMI_DATA_DIRECTORY)
      || !/\.(wav|m4a|mp3|aiff|flac|ogg)$/iu.test(resolved))) {
      throw new Error('只能播放已登记音频或私有运行目录之外的现有音频文件');
    }
    if (registered && path.dirname(resolved) !== await realpath(this.outputDirectory)) {
      throw new Error('已登记音频不能通过符号链接越出产物目录');
    }
    await access(resolved, fsConstants.R_OK);
    return resolved;
  }

  async speak(
    text: string,
    options: SpeechSynthesisOptions = {},
    signal?: AbortSignal,
  ): Promise<SpeechAudio> {
    const audio = await this.synthesize(text, options, signal);
    return this.play(audio, signal);
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new Error('TTS 已关闭；调用 speech.setEnabled(true) 或设置 MIMI_TTS_ENABLED=true 后再试');
    }
  }

  private async assertCommandsAvailable(includePlayback = true): Promise<void> {
    await access(this.config.command, fsConstants.X_OK).catch(() => {
      throw new Error(`TTS 渲染器不可执行：${this.config.command}`);
    });
    if (!includePlayback) return;
    await access(this.config.playbackCommand, fsConstants.X_OK).catch(() => {
      throw new Error(`TTS 播放器不可执行：${this.config.playbackCommand}`);
    });
  }

  private rememberError(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
  }
}

const sharedOutputs = new Map<string, SpeechOutput>();

export function sharedSpeechOutput(config: TtsConfig, dataRoot: string): SpeechOutput {
  const outputDirectory = path.join(dataRoot, 'media', 'tts');
  const key = JSON.stringify({ ...config, outputDirectory });
  const existing = sharedOutputs.get(key);
  if (existing) return existing;
  const created = new SpeechOutput(config, outputDirectory);
  sharedOutputs.set(key, created);
  return created;
}
