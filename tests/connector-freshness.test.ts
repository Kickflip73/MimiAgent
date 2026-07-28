import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ConnectorManager } from '../src/daemon/connectors.js';
import { NotifierRegistry } from '../src/daemon/notifier.js';
import { MimiStore } from '../src/daemon/store.js';

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition timed out');
}

test('marks an online Connector stale after its declared readiness heartbeat expires', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-connector-freshness-'));
  const database = path.join(root, 'mimi.db');
  const configFile = path.join(root, 'connectors.json');
  await mkdir(root, { recursive: true });
  await writeFile(configFile, JSON.stringify({
    connectors: {
      heartbeat: {
        command: process.execPath,
        args: ['-e', [
          "process.stdout.write(JSON.stringify({type:'status',inbound:'ready',outbound:'ready',freshForMs:1000})+'\\n');",
          'setInterval(() => {}, 60000);',
        ].join('')],
        restart: false,
        healthEvents: false,
      },
    },
  }));
  const store = new MimiStore(database);
  const manager = await ConnectorManager.load(configFile, store, new NotifierRegistry());
  manager.start();
  try {
    await waitUntil(() => Boolean(manager.listCapabilities()[0]?.readiness.reportedAt));
    const initial = manager.listCapabilities()[0]!;
    assert.equal(initial.online, true);
    assert.equal(initial.readiness.stale, false);
    assert.match(initial.readiness.reportedAt ?? '', /^20\d\d-/);
    assert.match(initial.readiness.freshUntil ?? '', /^20\d\d-/);

    const now = Date.now;
    Date.now = () => now() + 2_000;
    try {
      assert.equal(manager.listCapabilities()[0]?.readiness.stale, true);
    } finally {
      Date.now = now;
    }
  } finally {
    await manager.stop();
    store.close();
  }
});

test('registered read probes require enabled online fresh readiness and reject write or unknown actions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-connector-read-probe-'));
  const database = path.join(root, 'mimi.db');
  const configFile = path.join(root, 'connectors.json');
  await writeFile(configFile, JSON.stringify({
    connectors: {
      fixture: {
        command: process.execPath,
        args: [path.resolve('tests/fixtures/connector-fixture.mjs')],
        restart: false,
        healthEvents: false,
        actions: {
          inspect: { description: 'read fixture', capability: 'fixture.read', effect: 'read' },
          mutate: { description: 'write fixture', capability: 'fixture.write', effect: 'write' },
          legacy: { description: 'unknown fixture', capability: 'fixture.legacy', effect: 'unknown' },
        },
      },
    },
  }));
  const store = new MimiStore(database);
  const manager = await ConnectorManager.load(configFile, store, new NotifierRegistry());
  manager.start();
  try {
    await waitUntil(() => manager.listCapabilities()[0]?.readiness.outbound === 'ready');
    const receipt = await manager.executeReadProbe({
      connector: 'fixture',
      action: 'inspect',
      capability: 'fixture.read',
      target: 'bounded',
      payload: { limit: 1 },
    });
    assert.equal(receipt.boundary, 'connector_manager');
    assert.equal(receipt.effect, 'read');
    assert.equal(receipt.actionResult, true);
    const result = receipt.result as {
      requestId?: string;
      action?: string;
      target?: string;
      payload?: unknown;
    };
    assert.match(result.requestId ?? '', /^[0-9a-f-]{36}$/);
    assert.equal(result.action, 'inspect');
    assert.equal(result.target, 'bounded');
    assert.deepEqual(result.payload, { limit: 1 });
    await assert.rejects(() => manager.executeReadProbe({
      connector: 'fixture', action: 'mutate', capability: 'fixture.write', target: 'bounded', payload: {},
    }), /effect.*read|write/i);
    await assert.rejects(() => manager.executeReadProbe({
      connector: 'fixture', action: 'legacy', capability: 'fixture.legacy', target: 'bounded', payload: {},
    }), /effect.*read|unknown/i);
    await assert.rejects(() => manager.executeReadProbe({
      connector: 'fixture', action: 'missing', capability: 'fixture.read', target: 'bounded', payload: {},
    }), /未声明|unregistered/i);
    await assert.rejects(() => manager.executeReadProbe({
      connector: 'fixture', action: 'inspect', capability: 'wrong.read', target: 'bounded', payload: {},
    }), /capability.*drift/i);
    await manager.setEnabled('fixture', false);
    await assert.rejects(() => manager.executeReadProbe({
      connector: 'fixture', action: 'inspect', capability: 'fixture.read', target: 'bounded', payload: {},
    }), /disabled|未启用/i);
  } finally {
    await manager.stop();
    store.close();
  }
});
