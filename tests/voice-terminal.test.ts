import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseVoiceCliOptions,
  runVoiceConversation,
  type VoiceAgentPort,
  type VoiceConversationSource,
  type VoiceTranscript,
} from '../src/voice-terminal.js';

test('voice conversation sends stable transcripts through one canonical Session and speaks exact answers', async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const turns: VoiceTranscript[] = [
    { turnId: 'turn-1', text: '帮我总结今天的安排' },
    { turnId: 'turn-2', text: '把下午的事情再说一遍' },
  ];
  let spoken = 0;
  const source: VoiceConversationSource = {
    start: async () => { calls.push('source:start'); },
    nextTranscript: async (signal) => {
      const next = turns.shift();
      if (next) return next;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      throw new Error('unreachable');
    },
    pause: async () => { calls.push('source:pause'); },
    resume: async () => { calls.push('source:resume'); },
    speak: async (text) => {
      calls.push(`source:speak:${text}`);
      spoken += 1;
      if (spoken === 2) controller.abort(new Error('test complete'));
    },
    stop: async () => { calls.push('source:stop'); },
  };
  const agent: VoiceAgentPort = {
    openSession: async (requestedSessionId) => {
      calls.push(`agent:open:${requestedSessionId ?? 'new'}`);
      return { sessionId: requestedSessionId ?? 'voice-session-1' };
    },
    ask: async (text, sessionId) => {
      calls.push(`agent:ask:${sessionId}:${text}`);
      return text.startsWith('帮我') ? '今天上午评审，下午写方案。' : '下午需要完成方案。';
    },
    cancel: async () => { calls.push('agent:cancel'); },
  };
  const events: string[] = [];

  await runVoiceConversation({
    source,
    agent,
    signal: controller.signal,
    onEvent: (event) => {
      if (event.type === 'ready') events.push(`ready:${event.sessionId}`);
      if (event.type === 'user') events.push(`user:${event.text}`);
      if (event.type === 'assistant') events.push(`assistant:${event.text}`);
    },
  });

  assert.deepEqual(events, [
    'ready:voice-session-1',
    'user:帮我总结今天的安排',
    'assistant:今天上午评审，下午写方案。',
    'user:把下午的事情再说一遍',
    'assistant:下午需要完成方案。',
  ]);
  assert.deepEqual(calls, [
    'agent:open:new',
    'source:start',
    'source:pause',
    'agent:ask:voice-session-1:帮我总结今天的安排',
    'source:speak:今天上午评审，下午写方案。',
    'source:resume',
    'source:pause',
    'agent:ask:voice-session-1:把下午的事情再说一遍',
    'source:speak:下午需要完成方案。',
    'agent:cancel',
    'source:stop',
  ]);
});

test('voice CLI defaults to private Apple ASR and immediate system TTS', () => {
  assert.deepEqual(parseVoiceCliOptions([]), {
    locale: 'zh-CN',
    onDevice: true,
    tts: 'system',
  });
  assert.deepEqual(parseVoiceCliOptions([
    '--session', 'daily-voice',
    '--locale', 'en-US',
    '--allow-network-asr',
    '--tts', 'kokoro',
    '--voice', 'zm_yunyang',
    '--kokoro-renderer', '/opt/mimi/render-kokoro',
  ]), {
    sessionId: 'daily-voice',
    locale: 'en-US',
    onDevice: false,
    tts: 'kokoro',
    voice: 'zm_yunyang',
    kokoroRenderer: '/opt/mimi/render-kokoro',
  });
  assert.throws(() => parseVoiceCliOptions(['--tts', 'chattts']), /--tts/);
  assert.throws(() => parseVoiceCliOptions(['--session', '../other']), /--session/);
});

test('voice conversation releases the microphone source when startup fails', async () => {
  const calls: string[] = [];
  const failure = new Error('microphone permission denied');
  const source: VoiceConversationSource = {
    start: async () => {
      calls.push('source:start');
      throw failure;
    },
    nextTranscript: async () => { throw new Error('unreachable'); },
    pause: async () => undefined,
    resume: async () => undefined,
    speak: async () => undefined,
    stop: async () => { calls.push('source:stop'); },
  };
  const agent: VoiceAgentPort = {
    openSession: async () => ({ sessionId: 'voice-session-1' }),
    ask: async () => { throw new Error('unreachable'); },
    cancel: async () => undefined,
  };

  await assert.rejects(runVoiceConversation({
    source,
    agent,
    signal: new AbortController().signal,
  }), failure);
  assert.deepEqual(calls, ['source:start', 'source:stop']);
});
