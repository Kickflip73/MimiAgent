import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mostRestrictiveMessageMode,
  personalMessageContextSchema,
  personalMessagePayloadSchema,
  personalMessageResultSchema,
} from '../src/daemon/personal-message.js';

const fingerprint = `sha256:${'a'.repeat(64)}`;

test('all personal channels share one bounded payload schema', () => {
  for (const channel of ['daxiang', 'qq'] as const) {
    const payload = personalMessagePayloadSchema.parse({
      version: 1,
      channel,
      accountFingerprint: fingerprint,
      messageId: 'message-1',
      direction: 'incoming',
      messageType: 'text',
      coverage: 'bounded',
      preview: 'hello',
    });
    assert.equal(payload.channel, channel);
  }
  assert.throws(() => personalMessagePayloadSchema.parse({
    version: 1,
    channel: 'wechat',
    accountFingerprint: fingerprint,
    direction: 'incoming',
    messageType: 'text',
    coverage: 'bounded',
  }));
  assert.throws(() => personalMessagePayloadSchema.parse({
    version: 1,
    channel: 'daxiang',
    accountFingerprint: fingerprint,
    direction: 'incoming',
    messageType: 'text',
    coverage: 'bounded',
    preview: 'x'.repeat(4_001),
  }));
});

test('personal message context and result are bounded and explicit', () => {
  const context = personalMessageContextSchema.parse({
    channel: 'daxiang',
    accountFingerprint: fingerprint,
    conversationId: 'daxiang:account:123',
    coverage: 'bounded',
    observedAt: new Date().toISOString(),
    latestFingerprint: fingerprint,
    messages: [{ id: '1', direction: 'incoming', text: 'hello' }],
    truncated: false,
  });
  assert.equal(context.messages.length, 1);
  const result = personalMessageResultSchema.parse({
    status: 'observed',
    route: 'browser',
    deliveryConfirmed: false,
    accountVerified: true,
    targetVerified: true,
    messageId: 'message-1',
  });
  assert.equal(result.status, 'observed');
  assert.equal(result.messageId, 'message-1');
});

test('multiple source policies choose the most restrictive message mode', () => {
  assert.equal(mostRestrictiveMessageMode(['auto', 'confirm', 'draft']), 'draft');
  assert.equal(mostRestrictiveMessageMode([]), 'draft');
});
