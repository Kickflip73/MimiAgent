import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AudioFileTranscriptionPort } from './audio-file-analysis.js';

const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_CHARACTERS = 8_000;

export interface MacOsSpeechFileAsrOptions {
  platform?: NodeJS.Platform;
  swiftPath?: string;
  helperPath?: string;
  timeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
}

function safeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

export class MacOsSpeechFileAsrPort implements AudioFileTranscriptionPort {
  readonly adapterId = 'macos-speech-file-asr';
  readonly adapterVersion = '1';
  private readonly platform: NodeJS.Platform;
  private readonly swiftPath: string;
  private readonly helperPath: string;
  private readonly timeoutMs: number;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(options: MacOsSpeechFileAsrOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.swiftPath = options.swiftPath ?? '/usr/bin/swift';
    this.helperPath = options.helperPath ?? fileURLToPath(new URL(
      '../../examples/connectors/macos-voice-recognizer.swift',
      import.meta.url,
    ));
    this.timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 900_000) {
      throw new Error('macOS file ASR timeout must be between 100ms and 900000ms');
    }
    this.environment = safeEnvironment(options.environment ?? process.env);
  }

  async transcribe(input: {
    filePath: string;
    locale: string;
    onDevice: true;
    maxChars: number;
    signal?: AbortSignal;
  }): Promise<unknown> {
    input.signal?.throwIfAborted();
    if (this.platform !== 'darwin') {
      throw new Error('macOS/darwin Speech Framework file ASR is unavailable on this platform');
    }
    if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(input.locale)
      || !Number.isSafeInteger(input.maxChars) || input.maxChars < 1 || input.maxChars > 64_000) {
      throw new Error('macOS file ASR locale/maxChars is invalid');
    }
    await Promise.all([access(this.swiftPath), access(this.helperPath), access(input.filePath)]);
    input.signal?.throwIfAborted();
    const timeoutSeconds = Math.max(1, Math.ceil(this.timeoutMs / 1_000));

    return new Promise<unknown>((resolve, reject) => {
      const child = spawn(this.swiftPath, [
        this.helperPath,
        'transcribe',
        input.filePath,
        input.locale,
        'true',
        String(timeoutSeconds),
        String(input.maxChars),
        '',
      ], {
        env: this.environment,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderr = '';
      let terminalError: Error | undefined;
      let settled = false;
      const settle = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(value);
      };
      const stopWith = (error: Error) => {
        terminalError ??= error;
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        } else {
          child.kill('SIGKILL');
        }
      };
      const onAbort = () => stopWith(
        input.signal?.reason instanceof Error
          ? input.signal.reason
          : new Error('macOS file ASR was cancelled'),
      );
      const timer = setTimeout(() => {
        stopWith(new Error(`macOS file ASR timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      input.signal?.addEventListener('abort', onAbort, { once: true });
      if (input.signal?.aborted) onAbort();
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          stopWith(new Error(`macOS file ASR output exceeds ${MAX_STDOUT_BYTES} bytes`));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-MAX_STDERR_CHARACTERS);
      });
      child.once('error', (error) => settle(error));
      child.once('exit', (code, signal) => {
        if (terminalError) return settle(terminalError);
        if (code !== 0) {
          return settle(new Error((stderr || `macOS file ASR exited code=${code} signal=${signal ?? 'none'}`).trim()));
        }
        try {
          const text = Buffer.concat(stdout).toString('utf8').trim();
          if (!text) throw new Error('macOS file ASR returned an empty receipt');
          settle(undefined, JSON.parse(text) as unknown);
        } catch (error) {
          settle(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }
}
