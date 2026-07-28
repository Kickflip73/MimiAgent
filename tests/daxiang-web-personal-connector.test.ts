import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DaxiangWebAdapter,
  parseDaxiangConfig,
} from '../examples/connectors/personal-message/daxiang-web.mjs';

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

const pageShape = {
  bridgeMajor: 1,
  origin: 'https://x.sankuai.com',
  sessionTag: 'DIV',
  stableSessionCount: 2,
  messageTag: 'DIV',
  stableMessageCount: 3,
  inputCount: 1,
  inputTag: 'TEXTAREA',
  sendButtonCount: 1,
  sendButtonTag: 'BUTTON',
};
const selfLabel = 'Owner Self';
const accountFingerprint = sha256([
  'daxiang-web-v1',
  'https://x.sankuai.com',
  '123',
  sha256(selfLabel),
].join('\0'));
const pageFingerprint = sha256(JSON.stringify({
  bridgeMajor: pageShape.bridgeMajor,
  origin: pageShape.origin,
  sessionTag: pageShape.sessionTag,
  messageTag: pageShape.messageTag,
  inputCount: pageShape.inputCount,
  inputTag: pageShape.inputTag,
  sendButtonCount: pageShape.sendButtonCount,
  sendButtonTag: pageShape.sendButtonTag,
}));

class FakeDriver {
  commits = 0;
  observeStatus: 'observed' | 'failed' | 'pending' = 'observed';
  candidateMatched = true;
  candidateType: 'chat' | 'groupchat' = 'chat';
  messages = [{
    mid: '9001',
    direction: 'incoming',
    actorId: 'actor-1',
    text: 'hello',
    occurredAt: '2026-07-27T10:00:00.000Z',
    receipt: null,
  }];

  async locate(_marker?: string, _allowBind = false): Promise<Record<string, unknown>> {
    return { tab: { active: false } };
  }

  async execute(_marker: string, script: string): Promise<{ value: string | null }> {
    const method = /__mimiDaxiangBridge\.([a-zA-Z]+)\(/.exec(script)?.[1];
    if (!method) return { value: null };
    let result: unknown;
    if (method === 'inspect') {
      result = {
        version: '1.0.0',
        selfRowCount: 1,
        selfRowLabel: selfLabel,
        pageShape,
        readable: true,
        sendStructureReady: true,
      };
    } else if (method === 'installObserver') result = { installed: true };
    else if (method === 'drain') result = [];
    else if (method === 'targetCandidate') result = {
      matched: this.candidateMatched,
      sid: '123',
      type: this.candidateType,
      count: this.candidateMatched ? 1 : 0,
    };
    else if (method === 'selectConversation') result = { selected: true, changed: false };
    else if (method === 'readCurrentConversation') {
      result = {
        matched: true,
        sid: '123',
        type: 'chat',
        messages: this.messages,
        capturedAt: '2026-07-27T10:00:01.000Z',
        readStateChanged: 'unknown',
      };
    } else if (method === 'prepareSend') result = { prepared: true };
    else if (method === 'commitSend') {
      this.commits += 1;
      result = { dispatched: true, repeated: false };
    } else if (method === 'observeSend') {
      result = this.observeStatus === 'observed'
        ? {
            status: 'observed',
            message: { mid: '9002', direction: 'outgoing', text: '收到' },
            draftEmpty: true,
          }
        : this.observeStatus === 'failed'
          ? { status: 'failed', reason: 'page_marked_send_failed' }
          : { status: 'pending' };
    } else throw new Error(`unexpected bridge method ${method}`);
    return { value: JSON.stringify(result) };
  }
}

function config() {
  return parseDaxiangConfig({
    schemaVersion: 1,
    tabMarker: 'marker-1',
    expectedAccountFingerprint: accountFingerprint,
    allowedPageFingerprints: [pageFingerprint],
    selfConversation: {
      sid: '123',
      type: 'chat',
      binding: {
        selectedBy: 'owner',
        accountFingerprint,
        authorizationRevision: 'owner-revision-1',
      },
    },
    watch: {
      enabled: true,
      pollIntervalMs: 30_000,
      conversations: [{
        sid: '123',
        type: 'chat',
        label: 'self',
        binding: {
          selectedBy: 'owner',
          accountFingerprint,
          authorizationRevision: 'owner-revision-1',
        },
      }],
    },
    limits: { contextMessages: 50, eventPreviewChars: 4_000 },
  });
}

test('Daxiang config rejects unstable targets and unknown fields', () => {
  assert.throws(() => parseDaxiangConfig({
    ...config(),
    extra: true,
  }), /not supported/);
  assert.throws(() => parseDaxiangConfig({
    ...config(),
    selfConversation: { sid: 'display-name', type: 'chat' },
  }), /digits only/);
  assert.throws(() => parseDaxiangConfig({
    ...config(),
    selfConversation: {
      ...config().selfConversation,
      binding: { ...config().selfConversation.binding, selectedBy: 'model' },
    },
  }), /selectedBy must be owner/);
  assert.throws(() => parseDaxiangConfig({
    ...config(),
    selfConversation: {
      ...config().selfConversation,
      binding: {
        ...config().selfConversation.binding,
        authorizationRevision: 'owner revision with spaces',
      },
    },
  }), /authorizationRevision is invalid/);
});

test('Daxiang exposes target-not-bound and refuses bounded context before owner binding', async () => {
  const unbound = parseDaxiangConfig({
    ...config(),
    selfConversation: { sid: '123', type: 'chat' },
    watch: {
      ...config().watch,
      conversations: [{ sid: '123', type: 'chat', label: 'self' }],
    },
  });
  const adapter = new DaxiangWebAdapter({
    config: unbound,
    driver: new FakeDriver(),
    bridgeSource: 'bridge',
    stateFile: path.join(os.tmpdir(), `daxiang-unbound-${Date.now()}.json`),
  });
  const health = await adapter.health({ probe: true });
  assert.equal(health.targetBound, false);
  assert.equal(health.contextRead, 'unavailable');
  await assert.rejects(() => adapter.getContext({
    accountFingerprint,
    sid: '123',
    type: 'chat',
    limit: 1,
  }), /target_not_bound/);
});

test('Daxiang account and page changes fail closed without losing honest bounded-read coverage', async () => {
  const mismatchedAccount = new DaxiangWebAdapter({
    config: parseDaxiangConfig({
      ...config(),
      expectedAccountFingerprint: `sha256:${'f'.repeat(64)}`,
    }),
    driver: new FakeDriver(),
    bridgeSource: 'bridge',
    stateFile: path.join(os.tmpdir(), `daxiang-account-mismatch-${Date.now()}.json`),
  });
  const accountHealth = await mismatchedAccount.health({ probe: true });
  assert.equal(accountHealth.accountVerified, false);
  assert.equal(accountHealth.contextRead, 'unavailable');
  assert.equal(accountHealth.outbound, 'unavailable');

  const mismatchedPage = new DaxiangWebAdapter({
    config: parseDaxiangConfig({
      ...config(),
      allowedPageFingerprints: [],
    }),
    driver: new FakeDriver(),
    bridgeSource: 'bridge',
    stateFile: path.join(os.tmpdir(), `daxiang-page-mismatch-${Date.now()}.json`),
  });
  const pageHealth = await mismatchedPage.health({ probe: true });
  assert.equal(pageHealth.accountVerified, true);
  assert.equal(pageHealth.targetBound, true);
  assert.equal(pageHealth.contextRead, 'bounded');
  assert.equal(pageHealth.coverage, 'bounded');
  assert.equal(pageHealth.outbound, 'unavailable');
});

test('Daxiang rejects a configured binding that is absent or type-mismatched on the current page', async () => {
  for (const [index, mutate] of [
    (driver: FakeDriver) => { driver.candidateMatched = false; },
    (driver: FakeDriver) => { driver.candidateType = 'groupchat'; },
  ].entries()) {
    const driver = new FakeDriver();
    mutate(driver);
    const adapter = new DaxiangWebAdapter({
      config: config(),
      driver,
      bridgeSource: 'bridge',
      stateFile: path.join(os.tmpdir(), `daxiang-candidate-mismatch-${Date.now()}-${index}.json`),
    });
    const health = await adapter.health({ probe: true });
    assert.equal(health.accountVerified, true);
    assert.equal(health.targetBound, false);
    assert.equal(health.targetBindingStatus, 'target_not_bound');
    assert.equal(health.contextRead, 'unavailable');
  }
});

test('Daxiang adapter baselines history, emits new bounded events, and advances only after ACK', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'daxiang-personal-'));
  const stateFile = path.join(root, 'state', 'cursor.json');
  const driver = new FakeDriver();
  const adapter = new DaxiangWebAdapter({
    config: config(),
    driver,
    bridgeSource: 'bridge',
    stateFile,
  });

  const health = await adapter.health({ probe: true });
  assert.equal(health.accountVerified, true);
  assert.equal(health.pageAllowed, true);
  assert.equal(health.deliveryConfirmed, false);

  const first = await adapter.poll();
  assert.equal(first.events.length, 0);
  driver.messages.push({
    mid: '9002',
    direction: 'incoming',
    actorId: 'actor-1',
    text: 'new message',
    occurredAt: '2026-07-27T10:00:02.000Z',
    receipt: null,
  });

  const afterBaseline = await adapter.poll();
  assert.equal(afterBaseline.events.length, 1);
  const firstEvent = afterBaseline.events[0];
  assert.ok(firstEvent);
  assert.equal(firstEvent.externalId, `daxiang:${accountFingerprint.slice(7, 23)}:123:9002`);
  assert.equal(firstEvent.payload.coverage, 'bounded');
  assert.equal(firstEvent.replyTarget, undefined);
  assert.match(firstEvent.actor.id, /^sha256:[a-f0-9]{64}$/);

  const beforeAck = await adapter.poll();
  assert.equal(beforeAck.events.length, 1);
  await adapter.acknowledge([firstEvent.externalId]);
  const afterAck = await adapter.poll();
  assert.equal(afterAck.events.length, 0);
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(stateFile, 'utf8'), /hello|new message|Owner Self/);
});

test('Daxiang health automatically rebinds one safe background tab without foreground activation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'daxiang-recovery-'));
  const diagnosticsFile = path.join(root, 'diagnostics.json');
  class RecoverableDriver extends FakeDriver {
    locateModes: boolean[] = [];

    override async locate(_marker?: string, allowBind = false): Promise<Record<string, unknown>> {
      this.locateModes.push(allowBind);
      if (!allowBind) throw new Error('Daxiang bound tab is missing or ambiguous');
      return { tab: { active: false } };
    }
  }
  const driver = new RecoverableDriver();
  const adapter = new DaxiangWebAdapter({
    config: config(),
    driver,
    bridgeSource: 'bridge',
    stateFile: path.join(root, 'cursor.json'),
    diagnosticsFile,
  });

  const health = await adapter.health();
  assert.equal(health.accountVerified, true);
  assert.equal(health.recoveryAttempted, true);
  assert.equal(health.recovered, true);
  assert.deepEqual(driver.locateModes, [false, true]);
  const diagnostics = JSON.parse(await readFile(diagnosticsFile, 'utf8')) as Record<string, unknown>;
  assert.equal(diagnostics.recoveryAttempted, true);
  assert.equal(diagnostics.recovered, true);
});

test('Daxiang send clicks once and reports observed rather than confirmed', async () => {
  const driver = new FakeDriver();
  const adapter = new DaxiangWebAdapter({
    config: config(),
    driver,
    bridgeSource: 'bridge',
    stateFile: path.join(os.tmpdir(), `daxiang-${Date.now()}.json`),
  });
  await adapter.health({ probe: true });
  const context = await adapter.getContext({
    accountFingerprint,
    sid: '123',
    type: 'chat',
    limit: 30,
  });
  const result = await adapter.send({
    accountFingerprint,
    sid: '123',
    type: 'chat',
    text: '收到',
    latestFingerprint: context.latestFingerprint,
  });
  assert.equal(driver.commits, 1);
  assert.equal(result.status, 'observed');
  assert.equal(result.deliveryConfirmed, false);
});

test('Daxiang send reports an explicit page failure without clicking again', async () => {
  const driver = new FakeDriver();
  driver.observeStatus = 'failed';
  const adapter = new DaxiangWebAdapter({
    config: config(),
    driver,
    bridgeSource: 'bridge',
    stateFile: path.join(os.tmpdir(), `daxiang-failed-${Date.now()}.json`),
  });
  await adapter.health({ probe: true });
  const context = await adapter.getContext({
    accountFingerprint,
    sid: '123',
    type: 'chat',
    limit: 1,
  });
  const result = await adapter.send({
    accountFingerprint,
    sid: '123',
    type: 'chat',
    text: '收到',
    latestFingerprint: context.latestFingerprint,
  });
  assert.equal(driver.commits, 1);
  assert.equal(result.status, 'failed');
  assert.match(String(result.error), /page_marked_send_failed/);
});

test('Daxiang post-click timeout is uncertain and never retries or falls back', async () => {
  const driver = new FakeDriver();
  driver.observeStatus = 'pending';
  const adapter = new DaxiangWebAdapter({
    config: config(),
    driver,
    bridgeSource: 'bridge',
    stateFile: path.join(os.tmpdir(), `daxiang-timeout-${Date.now()}.json`),
    sendObservationTimeoutMs: 10,
  });
  await adapter.health({ probe: true });
  const context = await adapter.getContext({
    accountFingerprint,
    sid: '123',
    type: 'chat',
    limit: 1,
  });
  const result = await adapter.send({
    accountFingerprint,
    sid: '123',
    type: 'chat',
    text: '收到',
    latestFingerprint: context.latestFingerprint,
  });
  assert.equal(driver.commits, 1);
  assert.equal(result.status, 'uncertain');
  assert.match(String(result.error), /timed out/);
  assert.equal(result.route, 'browser');
});

test('Daxiang page bridge has no credential access or foreground activation path', async () => {
  const bridge = await readFile(
    fileURLToPath(new URL('../examples/connectors/personal-message/daxiang-web-page-bridge.js', import.meta.url)),
    'utf8',
  );
  assert.doesNotMatch(bridge, /(?:cookie|localStorage|indexedDB|activate\(|clipboard|keyCode)/i);
  assert.match(bridge, /\(\?:me\|from-me/);
  assert.match(bridge, /\(\?:you\|from-other/);
  assert.match(bridge, /page_marked_send_failed/);
  new Function(bridge);
});
