import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from './config.js';
import { assertSessionId } from './core/session-id.js';
import {
  eventAnswer,
  MimiChatClient,
  type AcceptedMimiEvent,
} from './daemon/chat-client.js';
import { VOICE_CONVERSATION_RUN_POLICY } from './daemon/local-run-policy.js';

const DEFAULT_VOICE_TURN_TIMEOUT_MS = 120_000;

export type VoiceTtsEngine = 'system' | 'kokoro';

export interface VoiceCliOptions {
  sessionId?: string;
  locale: string;
  onDevice: boolean;
  tts: VoiceTtsEngine;
  voice?: string;
  kokoroRenderer?: string;
}

export interface VoiceTranscript {
  turnId: string;
  text: string;
}

export interface VoiceConversationSource {
  start(): Promise<void>;
  nextTranscript(signal: AbortSignal): Promise<VoiceTranscript>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  speak(text: string, signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
}

export interface VoiceAgentPort {
  openSession(requestedSessionId?: string): Promise<{ sessionId: string }>;
  ask(text: string, sessionId: string, signal: AbortSignal): Promise<string>;
  cancel(reason: Error): Promise<void>;
}

export type VoiceConversationEvent =
  | { type: 'ready'; sessionId: string }
  | { type: 'user'; text: string; turnId: string }
  | { type: 'processing'; turnId: string }
  | { type: 'assistant'; text: string; turnId: string }
  | { type: 'error'; error: Error };

export const VOICE_HELP = `MimiAgent 语音对话

用法：
  mimi voice
  mimi voice --session <id>
  mimi voice --locale zh-CN [--allow-network-asr]
  mimi voice --tts system [--voice <系统声音>]
  mimi voice --tts kokoro [--voice <Kokoro音色>] --kokoro-renderer <绝对路径>

默认使用 macOS Speech Framework 的设备端识别和系统 TTS。Kokoro 是显式可选的
本地高质量 TTS；缺少 renderer 时不会静默改用云端服务。按 Ctrl-C 退出。`;

function optionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} 需要一个值`);
  return value;
}

function voiceName(value: string, option: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${option} 必须是 1～200 个无控制字符的文本`);
  }
  return normalized;
}

function localeValue(value: string): string {
  if (!/^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8})*$/u.test(value) || value.length > 35) {
    throw new Error('--locale 必须是 zh-CN、en-US 这样的 locale');
  }
  return value.replaceAll('_', '-');
}

export function parseVoiceCliOptions(args: string[]): VoiceCliOptions {
  const options: VoiceCliOptions = {
    locale: 'zh-CN',
    onDevice: true,
    tts: 'system',
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--session') {
      const value = optionValue(args, index, argument);
      try {
        options.sessionId = assertSessionId(value);
      } catch (error) {
        throw new Error(`--session 无效：${error instanceof Error ? error.message : String(error)}`);
      }
      index += 1;
      continue;
    }
    if (argument === '--locale') {
      options.locale = localeValue(optionValue(args, index, argument));
      index += 1;
      continue;
    }
    if (argument === '--allow-network-asr') {
      options.onDevice = false;
      continue;
    }
    if (argument === '--tts') {
      const value = optionValue(args, index, argument);
      if (value !== 'system' && value !== 'kokoro') {
        throw new Error('--tts 只支持 system 或 kokoro');
      }
      options.tts = value;
      index += 1;
      continue;
    }
    if (argument === '--voice') {
      options.voice = voiceName(optionValue(args, index, argument), argument);
      index += 1;
      continue;
    }
    if (argument === '--kokoro-renderer') {
      const value = optionValue(args, index, argument);
      if (!path.isAbsolute(value)) throw new Error('--kokoro-renderer 必须是绝对路径');
      options.kokoroRenderer = path.normalize(value);
      index += 1;
      continue;
    }
    throw new Error(`未知 voice 参数：${argument}`);
  }
  if (options.tts === 'kokoro' && !options.kokoroRenderer) {
    throw new Error('--tts kokoro 需要 --kokoro-renderer <绝对路径>');
  }
  return options;
}

function aborted(signal: AbortSignal, error: unknown): boolean {
  return signal.aborted && (error === signal.reason
    || (error instanceof Error && error.name === 'AbortError'));
}

export async function runVoiceConversation(input: {
  source: VoiceConversationSource;
  agent: VoiceAgentPort;
  signal: AbortSignal;
  requestedSessionId?: string;
  turnTimeoutMs?: number;
  onEvent?: (event: VoiceConversationEvent) => void;
}): Promise<void> {
  const session = await input.agent.openSession(input.requestedSessionId);
  const turnTimeoutMs = input.turnTimeoutMs ?? DEFAULT_VOICE_TURN_TIMEOUT_MS;
  if (!Number.isSafeInteger(turnTimeoutMs) || turnTimeoutMs <= 0) {
    throw new Error('语音轮次超时必须是正整数毫秒');
  }
  let sourcePaused = false;
  try {
    await input.source.start();
    input.onEvent?.({ type: 'ready', sessionId: session.sessionId });
    while (!input.signal.aborted) {
      let turn: VoiceTranscript;
      try {
        turn = await input.source.nextTranscript(input.signal);
      } catch (error) {
        if (aborted(input.signal, error)) break;
        throw error;
      }
      const text = turn.text.trim();
      if (!text) continue;
      await input.source.pause();
      sourcePaused = true;
      input.onEvent?.({ type: 'user', text, turnId: turn.turnId });
      input.onEvent?.({ type: 'processing', turnId: turn.turnId });
      const turnController = new AbortController();
      const timeoutError = new Error(`Mimi 语音回答等待超过 ${turnTimeoutMs}ms，已取消本轮`);
      const timeout = setTimeout(() => turnController.abort(timeoutError), turnTimeoutMs);
      const turnSignal = AbortSignal.any([input.signal, turnController.signal]);
      try {
        const answer = (await input.agent.ask(text, session.sessionId, turnSignal)).trim();
        clearTimeout(timeout);
        if (!answer) throw new Error('MimiAgent 返回了空回答');
        input.onEvent?.({ type: 'assistant', text: answer, turnId: turn.turnId });
        await input.source.speak(answer, input.signal);
      } catch (error) {
        if (aborted(input.signal, error)) break;
        if (turnController.signal.aborted) {
          await input.agent.cancel(timeoutError).catch(() => undefined);
        }
        const normalized = error instanceof Error ? error : new Error(String(error));
        input.onEvent?.({ type: 'error', error: normalized });
      } finally {
        clearTimeout(timeout);
        if (sourcePaused && !input.signal.aborted) {
          await input.source.resume();
          sourcePaused = false;
        }
      }
    }
  } finally {
    if (input.signal.aborted) {
      await input.agent.cancel(new Error('用户已退出语音对话')).catch(() => undefined);
    }
    await input.source.stop();
  }
}

interface ConnectorMessage {
  type?: string;
  id?: string;
  ok?: boolean;
  externalId?: string;
  payload?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
}

interface ConnectorWaiter {
  resolve: (message: ConnectorMessage) => void;
  reject: (error: Error) => void;
}

export class MacOsVoiceConversationSource implements VoiceConversationSource {
  private child: ChildProcessWithoutNullStreams | undefined;
  private temporaryRoot: string | undefined;
  private failure: Error | undefined;
  private stdout = '';
  private stderr = '';
  private readonly actions = new Map<string, ConnectorWaiter>();
  private readonly transcripts: VoiceTranscript[] = [];
  private readonly transcriptWaiters: Array<{
    resolve: (turn: VoiceTranscript) => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(private readonly options: VoiceCliOptions) {}

  async start(): Promise<void> {
    if (this.child) return;
    this.failure = undefined;
    this.temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'mimi-voice-'));
    await chmod(this.temporaryRoot, 0o700);
    const connector = fileURLToPath(new URL('../examples/connectors/macos-voice-connector.mjs', import.meta.url));
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG,
      TMPDIR: process.env.TMPDIR,
      MACOS_VOICE_LISTEN: 'true',
      MACOS_VOICE_REQUIRE_WAKE_PHRASE: 'false',
      MACOS_VOICE_LOCALE: this.options.locale,
      MACOS_VOICE_ON_DEVICE: String(this.options.onDevice),
      MACOS_VOICE_SEGMENT_SECONDS: '30',
      MACOS_VOICE_END_SILENCE_MS: '900',
      MACOS_VOICE_REPLY_MAX_CHARS: '2000',
      MACOS_VOICE_STATE_FILE: path.join(this.temporaryRoot, 'listener-state.json'),
      MACOS_VOICE_TTS_ENGINE: this.options.tts,
      ...(this.options.kokoroRenderer
        ? { MACOS_VOICE_KOKORO_RENDERER: this.options.kokoroRenderer }
        : {}),
    };
    const child = spawn(process.execPath, [connector], {
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk));
    child.stderr.on('data', (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8_000);
    });
    child.once('error', (error) => this.fail(error));
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = undefined;
      this.fail(new Error(
        this.stderr.trim() || `macOS voice connector exited code=${code ?? 'none'} signal=${signal ?? 'none'}`,
      ));
    });
    const deadline = Date.now() + 35_000;
    while (Date.now() < deadline) {
      const status = await this.action('listener_status', 'listener', {});
      if (status.result?.ready === true) return;
      if (typeof status.result?.lastError === 'string' && status.result.lastError) {
        throw new Error(status.result.lastError);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('macOS 语音识别启动超时；请检查麦克风和 Speech 权限');
  }

  async nextTranscript(signal: AbortSignal): Promise<VoiceTranscript> {
    if (this.failure) throw this.failure;
    const queued = this.transcripts.shift();
    if (queued) return queued;
    signal.throwIfAborted();
    return await new Promise<VoiceTranscript>((resolve, reject) => {
      const waiter = {
        resolve: (turn: VoiceTranscript) => {
          signal.removeEventListener('abort', onAbort);
          resolve(turn);
        },
        reject: (error: Error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
      const onAbort = () => {
        const index = this.transcriptWaiters.indexOf(waiter);
        if (index >= 0) this.transcriptWaiters.splice(index, 1);
        reject(signal.reason instanceof Error ? signal.reason : new Error('语音对话已停止'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.transcriptWaiters.push(waiter);
    });
  }

  async pause(): Promise<void> {
    await this.action('listener_stop', 'listener', {});
  }

  async resume(): Promise<void> {
    await this.action('listener_start', 'listener', {});
  }

  async speak(text: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const response = await this.request({
      type: 'deliver',
      id: randomUUID(),
      target: this.options.voice ?? 'default',
      payload: { text },
    }, signal);
    if (response.ok !== true) throw new Error(response.error || '语音播报失败');
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 2_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    const temporaryRoot = this.temporaryRoot;
    this.temporaryRoot = undefined;
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  }

  private async action(
    action: string,
    target: string,
    payload: Record<string, unknown>,
  ): Promise<ConnectorMessage> {
    const response = await this.request({
      type: 'action', id: randomUUID(), action, target, payload,
    });
    if (response.ok !== true) throw new Error(response.error || `语音 action ${action} 失败`);
    return response;
  }

  private async request(
    message: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ConnectorMessage> {
    const child = this.child;
    const id = typeof message.id === 'string' ? message.id : '';
    if (!child || !id || child.exitCode !== null || child.signalCode !== null) {
      throw new Error('macOS voice connector 未运行');
    }
    signal?.throwIfAborted();
    return await new Promise<ConnectorMessage>((resolve, reject) => {
      const onAbort = () => {
        this.actions.delete(id);
        reject(signal?.reason instanceof Error ? signal.reason : new Error('语音播报已停止'));
      };
      const settle = <T>(callback: (value: T) => void) => (value: T) => {
        signal?.removeEventListener('abort', onAbort);
        callback(value);
      };
      this.actions.set(id, {
        resolve: settle(resolve),
        reject: settle(reject),
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (!error) return;
        this.actions.delete(id);
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      });
    });
  }

  private consumeStdout(chunk: string): void {
    this.stdout += chunk;
    if (Buffer.byteLength(this.stdout) > 1_000_000) {
      this.fail(new Error('macOS voice connector 输出超过 1 MiB'));
      return;
    }
    while (this.stdout.includes('\n')) {
      const newline = this.stdout.indexOf('\n');
      const line = this.stdout.slice(0, newline).trim();
      this.stdout = this.stdout.slice(newline + 1);
      if (!line) continue;
      let message: ConnectorMessage;
      try {
        message = JSON.parse(line) as ConnectorMessage;
      } catch {
        this.fail(new Error('macOS voice connector 返回了无效 JSON'));
        return;
      }
      if (message.type === 'listener_error') {
        this.fail(new Error(message.error || 'macOS 语音识别失败'));
        continue;
      }
      if (message.id && this.actions.has(message.id)) {
        const waiter = this.actions.get(message.id)!;
        this.actions.delete(message.id);
        waiter.resolve(message);
        continue;
      }
      const text = message.payload?.text;
      if (message.type !== 'event' || typeof text !== 'string' || !text.trim()) continue;
      const turn = {
        turnId: message.externalId || `voice:${randomUUID()}`,
        text: text.trim(),
      };
      const waiter = this.transcriptWaiters.shift();
      if (waiter) waiter.resolve(turn);
      else this.transcripts.push(turn);
    }
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const waiter of this.actions.values()) waiter.reject(error);
    this.actions.clear();
    for (const waiter of this.transcriptWaiters.splice(0)) waiter.reject(error);
  }
}

export class MimiVoiceAgentPort implements VoiceAgentPort {
  private activeEvent: AcceptedMimiEvent | undefined;

  constructor(private readonly client: MimiChatClient) {}

  async openSession(requestedSessionId?: string): Promise<{ sessionId: string }> {
    await this.client.connect();
    const snapshot = requestedSessionId
      ? await this.client.snapshot(30, requestedSessionId)
      : await this.client.bootstrap();
    return { sessionId: snapshot.sessionId };
  }

  async ask(text: string, sessionId: string, signal: AbortSignal): Promise<string> {
    const accepted = await this.client.submit(text, sessionId);
    this.activeEvent = accepted;
    let terminal = false;
    try {
      const event = await this.client.wait(accepted.eventId, signal);
      terminal = true;
      return eventAnswer(event);
    } finally {
      if (terminal && this.activeEvent?.eventId === accepted.eventId) this.activeEvent = undefined;
    }
  }

  async cancel(reason: Error): Promise<void> {
    const active = this.activeEvent;
    if (!active) return;
    try {
      await this.client.cancel(active.eventId, reason.message);
    } finally {
      if (this.activeEvent?.eventId === active.eventId) this.activeEvent = undefined;
    }
  }
}

export async function runMimiVoice(config: AppConfig, args: string[]): Promise<void> {
  const options = parseVoiceCliOptions(args);
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('用户已退出语音对话'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await runVoiceConversation({
      source: new MacOsVoiceConversationSource(options),
      agent: new MimiVoiceAgentPort(new MimiChatClient(config, undefined, {
        requestedRunPolicy: VOICE_CONVERSATION_RUN_POLICY,
      })),
      signal: controller.signal,
      requestedSessionId: options.sessionId,
      onEvent: (event) => {
        if (event.type === 'ready') {
          process.stdout.write(
            `Mimi 语音对话已启动 · Session ${event.sessionId} · ASR ${options.onDevice ? '设备端' : '允许联网'} · TTS ${options.tts}\n`,
          );
          process.stdout.write('直接说话，等待转写和回答；按 Ctrl-C 退出。\n');
        } else if (event.type === 'user') {
          process.stdout.write(`\n你：${event.text}\n`);
        } else if (event.type === 'processing') {
          process.stdout.write('Mimi：正在处理...\n');
        } else if (event.type === 'assistant') {
          process.stdout.write(`Mimi：${event.text}\n`);
        } else {
          process.stderr.write(`语音轮次失败：${event.error.message}\n`);
        }
      },
    });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
