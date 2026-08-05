import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConnectorManager, ConnectorReadProbeRequest } from '../src/daemon/connectors.js';
import {
  assertReadOnlyProbeIdle,
  executeReadOnlyProbe,
} from '../src/daemon/read-only-probe.js';

function manager(requests: ConnectorReadProbeRequest[]): ConnectorManager {
  return {
    executeReadProbe: async (request: ConnectorReadProbeRequest) => {
      requests.push(request);
      const result = request.connector === 'browser'
        ? {
            total: 2,
            truncated: true,
          }
        : request.connector === 'macos-shortcuts'
          ? { items: ['Private Shortcut'], truncated: false }
          : {
              text: 'private OCR text',
              charCount: 16,
              lineCount: 1,
              capturedBytes: 1234,
            };
      return {
        boundary: 'connector_manager' as const,
        effect: 'read' as const,
        registered: true as const,
        ready: true as const,
        fresh: true as const,
        targetVerified: true as const,
        actionResult: true as const,
        result,
      };
    },
  } as unknown as ConnectorManager;
}

function computerWindow(expected?: { bundleId: string; pid: number; windowId: number }) {
  const target = { bundleId: 'com.apple.finder', pid: 42, windowId: 7 };
  assert.deepEqual(expected, expected ? target : undefined);
  return Promise.resolve({
    boundary: 'computer_manager' as const,
    effect: 'read' as const,
    registered: true as const,
    ready: true as const,
    fresh: true as const,
    targetVerified: true as const,
    actionResult: true as const,
    target,
  });
}

test('fixed connector probe profiles return only bounded metadata and formal receipts', async () => {
  const requests: ConnectorReadProbeRequest[] = [];
  const dependencies = { connectors: manager(requests), computerWindow };
  const browser = await executeReadOnlyProbe({ profile: 'browser-tabs' }, dependencies);
  const shortcuts = await executeReadOnlyProbe({ profile: 'shortcuts-catalog' }, dependencies);
  assert.deepEqual(requests, [
    {
      connector: 'browser',
      action: 'probe_tabs',
      capability: 'browser.tabs.read',
      target: 'all',
      payload: {},
    },
    {
      connector: 'macos-shortcuts',
      action: 'list_folders',
      capability: 'shortcuts.catalog.read',
      target: 'all',
      payload: { limit: 5 },
    },
  ]);
  assert.deepEqual(browser.metadata, {
    itemCount: 2,
    total: 2,
    unavailableCount: 0,
    truncated: true,
  });
  assert.deepEqual(shortcuts.metadata, { itemCount: 1, truncated: false });
  assert.doesNotMatch(JSON.stringify([browser, shortcuts]), /private|Shortcut|https:/);
});

test('screen probe binds a safe background window before and after a temporary read', async () => {
  const requests: ConnectorReadProbeRequest[] = [];
  const receipt = await executeReadOnlyProbe({ profile: 'screen-window' }, {
    connectors: manager(requests),
    computerWindow,
  });
  assert.equal(requests[0]?.target, 'window:7');
  assert.equal(requests[0]?.action, 'read_screen');
  assert.deepEqual(receipt.metadata, {
    charCount: 16,
    lineCount: 1,
    capturedBytes: 1234,
    truncated: false,
  });
  assert.doesNotMatch(JSON.stringify(receipt), /private OCR text/);
});

test('Computer profile discards target identity and metadata fallbacks never expose content', async () => {
  const requests: ConnectorReadProbeRequest[] = [];
  const computer = await executeReadOnlyProbe({ profile: 'computer-window' }, {
    connectors: manager(requests),
    computerWindow,
  });
  assert.deepEqual(computer.metadata, {});
  assert.doesNotMatch(JSON.stringify(computer), /com\\.apple\\.finder|windowId|pid/);

  const fallbackManager = {
    executeReadProbe: async (request: ConnectorReadProbeRequest) => ({
      boundary: 'connector_manager' as const,
      effect: 'read' as const,
      registered: true as const,
      ready: true as const,
      fresh: true as const,
      targetVerified: true as const,
      actionResult: true as const,
      result: request.connector === 'browser'
        ? []
        : { text: 'two\nprivate lines', charCount: -1, capturedBytes: 'unknown', truncated: true },
    }),
  } as unknown as ConnectorManager;
  const browser = await executeReadOnlyProbe({ profile: 'browser-tabs' }, {
    connectors: fallbackManager,
    computerWindow,
  });
  const screen = await executeReadOnlyProbe({ profile: 'screen-window' }, {
    connectors: fallbackManager,
    computerWindow,
  });
  assert.deepEqual(browser.metadata, {
    itemCount: 0,
    unavailableCount: 0,
    truncated: false,
  });
  assert.deepEqual(screen.metadata, {
    charCount: 17,
    lineCount: 2,
    capturedBytes: 0,
    truncated: true,
  });
  assert.doesNotMatch(JSON.stringify(screen), /private lines/);
});

test('probe profiles and idle gates fail closed', async () => {
  await assert.rejects(() => executeReadOnlyProbe({ profile: 'arbitrary-action' }, {
    connectors: manager([]),
    computerWindow,
  }));
  assert.doesNotThrow(() => assertReadOnlyProbeIdle({
    activeEventCount: 0,
    activeTaskCount: 0,
    activeHostMutations: 0,
    tasks: { running: 0 },
    outbox: { pending: 0, sending: 0 },
  }));
  const busy = [
    { activeEventCount: 1 },
    { activeTaskCount: 1 },
    { activeHostMutations: 1 },
    { tasks: { running: 1 } },
    { outbox: { pending: 1 } },
    { outbox: { sending: 1 } },
  ];
  for (const value of busy) {
    assert.throws(() => assertReadOnlyProbeIdle({
      activeEventCount: 0,
      activeTaskCount: 0,
      activeHostMutations: 0,
      tasks: { running: 0 },
      outbox: { pending: 0, sending: 0 },
      ...value,
    }), /not idle/);
  }
});
