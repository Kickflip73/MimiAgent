import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AttentionEngine } from '../src/daemon/attention.js';
import { decideEvent } from '../src/daemon/policy.js';
import { MimiStore } from '../src/daemon/store.js';
import type { EventEnvelope } from '../src/daemon/types.js';

const accountFingerprint = `sha256:${'a'.repeat(64)}`;

function event(direction: 'incoming' | 'outgoing' = 'incoming'): EventEnvelope {
  const now = new Date().toISOString();
  return {
    id: 'event-1',
    externalId: 'message-1',
    source: 'personal-message:daxiang',
    kind: 'command',
    trust: 'external',
    actor: { id: 'actor-1' },
    conversation: { id: 'daxiang:aaaaaaaaaaaaaaaa:123' },
    payload: {
      version: 1,
      channel: 'daxiang',
      accountFingerprint,
      messageId: '1',
      direction,
      messageType: 'text',
      coverage: 'bounded',
      preview: 'hello',
    },
    occurredAt: now,
    receivedAt: now,
    priority: 80,
    profileId: 'owner',
  };
}

test('personal message routing cannot be upgraded by a less restrictive matching policy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'personal-message-policy-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
    await attention.upsertSourcePolicy({
      id: 'auto',
      source: 'personal-message:daxiang',
      access: 'work',
      messageMode: 'auto',
      instructions: ['低风险事实确认可自动回复'],
    });
    await attention.upsertSourcePolicy({
      id: 'digest-conversation',
      source: 'personal-message:daxiang',
      conversation: 'daxiang:*',
      access: 'reply',
      messageMode: 'digest',
      instructions: ['当前会话只进入摘要'],
    });
    assert.deepEqual(attention.routeIngress(event()), {
      decision: 'digest',
      reasonCode: 'personal_message_digest',
    });
  } finally {
    store.close();
  }
});

test('outgoing personal messages never enter the reply loop', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'personal-message-outgoing-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
    assert.deepEqual(attention.routeIngress(event('outgoing')), {
      decision: 'observe_only',
      reasonCode: 'personal_message_outgoing',
    });
  } finally {
    store.close();
  }
});

test('personal messages without a stable sender stay in digest', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'personal-message-sender-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
    const message = event();
    delete message.actor;
    assert.deepEqual(attention.routeIngress(message), {
      decision: 'digest',
      reasonCode: 'personal_message_sender_unstable',
    });
  } finally {
    store.close();
  }
});

test('personal auto runs receive only narrow message tools', () => {
  const decision = decideEvent(
    event(),
    ['只处理低风险确认'],
    undefined,
    'work',
    false,
    undefined,
    undefined,
    'background',
    ['com.sankuai.xmpp'],
    'auto',
  );
  assert.equal(decision.action, 'run');
  assert.equal(decision.personalMessage?.mode, 'auto');
  assert.equal(decision.options?.personalConnectorOnly, true);
  const tools = decision.options?.policy?.allowedTools ?? [];
  assert.ok(tools.includes('get_personal_message_context'));
  assert.ok(tools.includes('send_personal_message'));
  assert.equal(tools.includes('connector_action'), false);
  assert.equal(tools.includes('run_shell'), false);
  assert.equal(tools.includes('computer_act'), false);
});

test('personal messages without a source policy remain draft-only', () => {
  const decision = decideEvent(
    event(),
    [],
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    'draft',
  );
  assert.equal(decision.action, 'run');
  assert.deepEqual(decision.options?.policy?.allowedTools, [
    'current_time',
    'calculate',
    'get_personal_message_context',
    'finish_mimi_silently',
  ]);
  assert.equal(decision.options?.policy?.allowSideEffects, false);
  assert.equal(decision.options?.policy?.allowSessionContext, false);
});

test('an exact owner confirmation in the same recent personal session unlocks only bounded send', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'personal-message-confirm-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
    await attention.upsertSourcePolicy({
      id: 'daxiang-confirm',
      source: 'personal-message:daxiang',
      actor: 'actor-1',
      conversation: 'daxiang:aaaaaaaaaaaaaaaa:123',
      access: 'reply',
      messageMode: 'confirm',
      instructions: ['只生成并确认低风险文本'],
    });
    const message = event();
    const stored = store.appendEvent({
      id: message.id,
      externalId: message.externalId,
      source: message.source,
      type: 'command.received',
      trust: message.trust,
      actor: message.actor,
      conversation: message.conversation,
      payload: message.payload,
      profileId: message.profileId,
      occurredAt: message.occurredAt,
      receivedAt: message.receivedAt,
    }).event;
    const draftTask = store.enqueueTask({
      id: 'draft-task',
      type: 'conversation',
      idempotencyKey: 'draft-task',
      triggerEventId: stored.id,
      authorityEventId: stored.id,
      profileId: 'owner',
      sessionKey: 'personal-session',
      objective: stored.payload,
      executor: 'session_actor',
      workspaceAccess: 'none',
      priority: 80,
    });
    store.claimTaskById(draftTask.id, 'worker');
    const draftAttempt = store.beginTaskAttempt(draftTask.id, 'worker', 'personal-session');
    store.completeTask(draftTask.id, 'worker', { answer: '建议回复：唯一确认文本' }, draftAttempt.id);

    const confirmedAt = new Date(Date.parse(message.receivedAt) + 60_000).toISOString();
    const owner = store.appendEvent({
      id: 'owner-confirm',
      externalId: 'owner-confirm',
      source: 'local-cli',
      type: 'command.received',
      trust: 'owner',
      payload: { prompt: '确认发送大象消息：唯一确认文本' },
      profileId: 'owner',
      occurredAt: confirmedAt,
      receivedAt: confirmedAt,
    }).event;
    const confirmTask = store.enqueueTask({
      id: 'confirm-task',
      type: 'conversation',
      idempotencyKey: 'confirm-task',
      triggerEventId: owner.id,
      authorityEventId: owner.id,
      profileId: 'owner',
      sessionKey: 'personal-session',
      objective: owner.payload,
      executor: 'session_actor',
      workspaceAccess: 'none',
      priority: 100,
    });
    const decision = attention.decideTask(confirmTask, owner, owner);
    assert.equal(decision.personalMessage?.approvedText, '唯一确认文本');
    assert.equal(decision.personalMessage?.eventId, message.id);
    assert.deepEqual(decision.options?.policy?.allowedSideEffectTools, ['send_personal_message']);
    assert.equal(decision.options?.policy?.allowedTools?.includes('connector_action'), false);
    assert.match(decision.options?.hostInstructions ?? '', /唯一确认文本/);
  } finally {
    store.close();
  }
});
