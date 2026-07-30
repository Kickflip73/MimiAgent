#!/usr/bin/env node

import readline from 'node:readline';
import { DaxiangWebAdapter } from './personal-message/daxiang-web.mjs';

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function errorText(error) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function parseChannel(argv) {
  const value = argv.find((argument) => argument.startsWith('--channel='));
  if (!value) throw new Error('--channel is required');
  const channel = value.slice('--channel='.length);
  if (channel !== 'daxiang') {
    throw new Error(`personal message adapter ${channel} is not implemented`);
  }
  return channel;
}

function statusFor(health) {
  return {
    type: 'status',
    inbound: health.inbound || 'unavailable',
    outbound: health.outbound || 'unavailable',
    deliveryConfirmed: false,
    eventAcknowledgement: true,
    freshForMs: 90_000,
    coverage: health.coverage || 'unavailable',
    accountVerified: health.accountVerified === true,
    backgroundSafe: health.backgroundSafe === true,
    changesReadState: health.changesReadState ?? 'unknown',
    stableConversationId: health.stableConversationId === true,
    stableMessageId: health.stableMessageId === true,
    contextRead: health.contextRead || 'unavailable',
    targetBound: health.targetBound === true,
    targetBindingStatus: health.targetBindingStatus || 'target_not_bound',
    ...(health.errorCategory ? { reasonCode: health.errorCategory } : {}),
    ...(health.lastObservedAt ? { lastObservedAt: health.lastObservedAt } : {}),
  };
}

class UnavailableAdapter {
  constructor(error) {
    this.error = error;
    this.pollIntervalMs = 30_000;
  }

  async health() {
    return {
      inbound: 'unavailable',
      outbound: 'unavailable',
      coverage: 'unavailable',
      accountVerified: false,
      backgroundSafe: false,
      changesReadState: 'unknown',
      stableConversationId: false,
      stableMessageId: false,
      contextRead: 'unavailable',
      deliveryConfirmed: false,
      errorCategory: 'configuration_unavailable',
    };
  }

  async poll() {
    return { events: [], health: await this.health() };
  }

  async getContext() {
    throw this.error;
  }

  async listTargets() {
    throw this.error;
  }

  async searchTargets() {
    throw this.error;
  }

  async bindTarget() {
    throw this.error;
  }

  async send() {
    throw this.error;
  }

  async sendToOwner() {
    return {
      status: 'failed',
      route: 'browser',
      deliveryConfirmed: false,
      accountVerified: false,
      targetVerified: false,
      error: `owner account or self conversation is not ready: ${errorText(this.error)}`,
    };
  }

  async acknowledge() {
    return { acknowledged: [] };
  }
}

const channel = parseChannel(process.argv.slice(2));
let adapter;
try {
  adapter = await DaxiangWebAdapter.create();
} catch (error) {
  process.stderr.write(`[personal-message:${channel}] unavailable: ${errorText(error)}\n`);
  adapter = new UnavailableAdapter(error instanceof Error ? error : new Error(String(error)));
}

let stopping = false;
let pollTimer;
let polling = false;
let pendingBatch;
let activeActions = 0;
let actionLane = Promise.resolve();

async function reportHealth(probe = false) {
  const health = await adapter.health({ probe });
  write(statusFor(health));
  return health;
}

async function poll() {
  if (stopping || polling || pendingBatch || activeActions > 0) {
    return { emitted: 0, pending: Boolean(pendingBatch), actionActive: activeActions > 0 };
  }
  polling = true;
  try {
    const result = await adapter.poll();
    write(statusFor(result.health));
    if (!result.events.length) return { emitted: 0, pending: false };
    pendingBatch = {
      ids: new Set(result.events.map((event) => event.externalId)),
      successful: new Set(),
      failed: false,
    };
    for (const event of result.events) write(event);
    return { emitted: result.events.length, pending: true };
  } catch (error) {
    process.stderr.write(`[personal-message:${channel}] poll failed: ${errorText(error)}\n`);
    write(statusFor(await adapter.health()));
    return { emitted: 0, pending: false, error: errorText(error) };
  } finally {
    polling = false;
  }
}

async function handleEventAck(message) {
  if (!pendingBatch || !pendingBatch.ids.has(message.externalId)) return;
  if (message.ok === true) pendingBatch.successful.add(message.externalId);
  else pendingBatch.failed = true;
  if (!pendingBatch.failed && pendingBatch.successful.size < pendingBatch.ids.size) return;
  const batch = pendingBatch;
  pendingBatch = undefined;
  if (!batch.failed) await adapter.acknowledge([...batch.ids]);
}

function targetConversation(target) {
  if (typeof target !== 'string' || !/^\d+$/.test(target)) throw new Error('target must be a configured numeric sid');
  const item = [
    adapter.config?.selfConversation,
    ...(adapter.config?.watch?.conversations || []),
  ].find((candidate) => candidate?.sid === target);
  if (!item) throw new Error('target sid is not in the configured allowlist');
  return item;
}

function targetSid(target) {
  if (typeof target !== 'string' || !/^\d+$/.test(target)) {
    throw new Error('target must be a numeric sid returned by list_targets');
  }
  return target;
}

async function handleAction(message) {
  if (typeof message.id !== 'string' || !message.id || typeof message.action !== 'string') {
    throw new Error('action requires id and action');
  }
  if (Number.isFinite(message.deadlineAt) && Date.now() >= Number(message.deadlineAt)) {
    throw new Error('action deadline already expired');
  }
  const payload = message.payload && typeof message.payload === 'object' && !Array.isArray(message.payload)
    ? message.payload
    : {};
  if (message.action === 'health_check') return reportHealth(payload.probe !== false);
  if (message.action === 'list_targets') return adapter.listTargets(payload);
  if (message.action === 'search_targets') return adapter.searchTargets(payload);
  if (message.action === 'bind_target') {
    return adapter.bindTarget({
      candidateToken: message.target,
    });
  }
  if (!['get_context', 'send_message', 'send_to_owner'].includes(message.action)) {
    throw new Error(`unsupported action: ${message.action}`);
  }
  if (message.action === 'get_context') {
    const health = await adapter.health();
    return adapter.getContext({
      accountFingerprint: payload.accountFingerprint || health.accountFingerprint,
      sid: targetSid(message.target),
      ...(payload.type ? { type: payload.type } : {}),
      limit: payload.limit,
    });
  }
  if (message.action === 'send_message') {
    const target = targetConversation(message.target);
    return adapter.send({
      accountFingerprint: payload.accountFingerprint,
      sid: target.sid,
      type: target.type,
      latestFingerprint: payload.latestFingerprint,
      text: payload.text,
    });
  }
  if (message.action === 'send_to_owner') {
    return adapter.sendToOwner(payload.text);
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write(`[personal-message:${channel}] invalid input JSON\n`);
    return;
  }
  if (message?.type === 'event_ack') {
    void handleEventAck(message).catch((error) => {
      process.stderr.write(`[personal-message:${channel}] event ACK failed: ${errorText(error)}\n`);
    });
    return;
  }
  if (message?.type !== 'action') return;
  activeActions += 1;
  const operation = actionLane.then(() => handleAction(message));
  actionLane = operation.then(() => undefined, () => undefined);
  void operation.then((result) => {
    write({ type: 'action_result', id: message.id, ok: true, result });
  }, (error) => {
    write({
      type: 'action_result',
      id: message.id,
      ok: false,
      uncertain: message.action === 'send_message' && /uncertain/i.test(errorText(error)),
      error: errorText(error),
    });
  }).finally(() => {
    activeActions -= 1;
    if (stopping && activeActions === 0) process.exit(0);
  });
});

write({
  type: 'status',
  inbound: 'unknown',
  outbound: 'unknown',
  deliveryConfirmed: false,
  eventAcknowledgement: true,
  freshForMs: 90_000,
  coverage: 'unavailable',
  accountVerified: false,
  backgroundSafe: false,
  changesReadState: 'unknown',
  stableConversationId: false,
  stableMessageId: false,
  contextRead: 'unavailable',
});
await reportHealth();
pollTimer = setInterval(() => { void poll(); }, adapter.pollIntervalMs);
pollTimer.unref();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    if (pollTimer) clearInterval(pollTimer);
    input.close();
    if (activeActions === 0) process.exit(0);
  });
}
