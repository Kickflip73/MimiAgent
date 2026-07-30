import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ActionFailedSafeError } from '../src/core/action-intent.js';
import {
  ConnectorManager,
  connectorReadinessMonitorAction,
  parseConnectorConfig,
} from '../src/daemon/connectors.js';
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

test('readiness monitor ignores legacy write or unknown health actions', () => {
  for (const effect of ['write', 'unknown'] as const) {
    const config = parseConnectorConfig({
      connectors: {
        unsafe: {
          command: process.execPath,
          readinessMonitor: { action: 'health_check' },
          actions: {
            health_check: {
              description: 'must never be replayed by the monitor',
              effect,
            },
          },
        },
      },
    });
    const connector = config.connectors.unsafe;
    assert.ok(connector);
    assert.equal(connectorReadinessMonitorAction(connector), undefined);
  }
  const config = parseConnectorConfig({
    connectors: {
      safe: {
        command: process.execPath,
        actions: {
          health_check: {
            description: 'safe monitor action',
            effect: 'read',
          },
        },
      },
    },
  });
  const connector = config.connectors.safe;
  assert.ok(connector);
  assert.equal(connectorReadinessMonitorAction(connector), 'health_check');
});

test('readiness monitor repairs an unavailable Connector through its declared read-only health action', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-connector-readiness-monitor-'));
  const database = path.join(root, 'mimi.db');
  const configFile = path.join(root, 'connectors.json');
  const logFile = path.join(root, 'monitor.log');
  await writeFile(configFile, JSON.stringify({
    connectors: {
      monitored: {
        command: process.execPath,
        args: [
          path.resolve('tests/fixtures/connector-readiness-monitor-fixture.mjs'),
          'recover',
          logFile,
        ],
        restart: true,
        healthEvents: false,
        readinessMonitor: {
          intervalMs: 100,
          restartAfterFailures: 2,
        },
        actions: {
          health_check: {
            description: 'read-only fixture health check',
            capability: 'fixture.health.read',
            effect: 'read',
          },
        },
      },
    },
  }));
  const store = new MimiStore(database);
  const manager = await ConnectorManager.load(configFile, store, new NotifierRegistry());
  manager.start();
  try {
    await waitUntil(() => manager.listCapabilities()[0]?.readiness.outbound === 'ready');
    const log = await readFile(logFile, 'utf8');
    assert.equal((log.match(/^spawn:/gm) ?? []).length, 1);
    assert.match(log, /^health:\d+:1$/m);
  } finally {
    await manager.stop();
    store.close();
  }
});

test('readiness monitor restarts only its Connector after bounded consecutive failures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-connector-readiness-restart-'));
  const database = path.join(root, 'mimi.db');
  const configFile = path.join(root, 'connectors.json');
  const logFile = path.join(root, 'monitor.log');
  await writeFile(configFile, JSON.stringify({
    connectors: {
      monitored: {
        command: process.execPath,
        args: [
          path.resolve('tests/fixtures/connector-readiness-monitor-fixture.mjs'),
          'unavailable',
          logFile,
        ],
        restart: true,
        healthEvents: false,
        healthStabilityMs: 100,
        readinessMonitor: {
          intervalMs: 100,
          restartAfterFailures: 2,
        },
        actions: {
          health_check: {
            description: 'read-only fixture health check',
            capability: 'fixture.health.read',
            effect: 'read',
          },
        },
      },
    },
  }));
  const store = new MimiStore(database);
  const manager = await ConnectorManager.load(configFile, store, new NotifierRegistry());
  manager.start();
  try {
    await waitUntil(() => {
      try {
        const log = readFileSync(logFile, 'utf8');
        return (log.match(/^spawn:/gm) ?? []).length >= 2;
      } catch {
        return false;
      }
    });
    const log = await readFile(logFile, 'utf8');
    const firstSpawn = log.match(/^spawn:(\d+)$/m)?.[1];
    const spawnPids = [...log.matchAll(/^spawn:(\d+)$/gm)].map((match) => match[1]);
    assert.ok(firstSpawn);
    assert.ok(spawnPids.some((pid) => pid !== firstSpawn));
    assert.match(log, /^health:\d+:2$/m);
  } finally {
    await manager.stop();
    store.close();
  }
});

test('registered read probes require enabled online routes and reject write or unknown actions', async () => {
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

test('Connector action_result distinguishes explicit rejection from uncertain execution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-connector-action-result-'));
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
          mutate: { description: 'write fixture', capability: 'fixture.write', effect: 'write' },
        },
      },
    },
  }));
  const store = new MimiStore(database);
  const manager = await ConnectorManager.load(configFile, store, new NotifierRegistry());
  manager.start();
  try {
    await waitUntil(() => manager.listCapabilities()[0]?.readiness.outbound === 'ready');
    await assert.rejects(
      manager.executeCapability({
        capability: 'fixture.write',
        action: 'mutate',
        target: 'rejected',
        payload: { invalid: true },
      }),
      (error: unknown) => (
        error instanceof ActionFailedSafeError
        && /rejected before execution/.test(error.message)
      ),
    );
    await assert.rejects(
      manager.executeCapability({
        capability: 'fixture.write',
        action: 'mutate',
        target: 'uncertain',
        payload: {},
      }),
      (error: unknown) => (
        error instanceof Error
        && error.name === 'UncertainDeliveryError'
      ),
    );
  } finally {
    await manager.stop();
    store.close();
  }
});

test('personal Connector actions receive a fresh execution timeout after earlier calls settle', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-personal-action-lane-'));
  const database = path.join(root, 'mimi.db');
  const configFile = path.join(root, 'connectors.json');
  await writeFile(configFile, JSON.stringify({
    connectors: {
      'personal-fixture': {
        command: process.execPath,
        args: [path.resolve('tests/fixtures/connector-fixture.mjs')],
        restart: false,
        healthEvents: false,
        actionTimeoutMs: 1_000,
        actions: {
          inspect: { description: 'serial read fixture', capability: 'fixture.read', effect: 'read' },
        },
      },
    },
  }));
  const store = new MimiStore(database);
  const manager = await ConnectorManager.load(configFile, store, new NotifierRegistry());
  manager.start();
  try {
    await waitUntil(() => manager.listCapabilities()[0]?.readiness.outbound === 'ready');
    const results = await Promise.all(Array.from({ length: 6 }, async (_, index) => (
      manager.executeCapability({
        capability: 'fixture.read',
        action: 'inspect',
        target: `serial-delay-${index}`,
        payload: { index },
      })
    )));
    assert.deepEqual(results.map((item) => (
      (item.result as { target?: string }).target
    )), Array.from({ length: 6 }, (_, index) => `serial-delay-${index}`));
    const current = manager.listCapabilities()[0];
    assert.equal(current?.online, true);
    assert.match(current?.readiness.freshUntil ?? '', /^20\d\d-/);
    assert.equal(current?.readiness.stale, false);
  } finally {
    await manager.stop();
    store.close();
  }
});

test('a registered read probe establishes and refreshes bounded readiness without bypassing unavailable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-connector-readiness-bootstrap-'));
  const database = path.join(root, 'mimi.db');
  const configFile = path.join(root, 'connectors.json');
  const fixture = path.resolve('tests/fixtures/connector-readiness-bootstrap.mjs');
  await writeFile(configFile, JSON.stringify({
    connectors: {
      bootstrap: {
        command: process.execPath,
        args: [fixture],
        restart: false,
        healthEvents: false,
        actions: {
          inspect: { description: 'read fixture', capability: 'fixture.read', effect: 'read' },
        },
      },
      unavailable: {
        command: process.execPath,
        args: [fixture, '--unavailable'],
        restart: false,
        healthEvents: false,
        actions: {
          inspect: { description: 'read fixture', capability: 'fixture.read', effect: 'read' },
        },
      },
    },
  }));
  const store = new MimiStore(database);
  const manager = await ConnectorManager.load(configFile, store, new NotifierRegistry());
  manager.start();
  try {
    await waitUntil(() => manager.listCapabilities().every((connector) => connector.online));
    await waitUntil(() => (
      manager.listCapabilities().find((connector) => connector.id === 'unavailable')
        ?.readiness.outbound === 'unavailable'
    ));

    const first = await manager.executeReadProbe({
      connector: 'bootstrap',
      action: 'inspect',
      capability: 'fixture.read',
      target: 'bounded',
      payload: { limit: 1 },
    });
    assert.equal(first.actionResult, true);
    const established = manager.listCapabilities().find((connector) => connector.id === 'bootstrap')!;
    assert.equal(established.readiness.inbound, 'unavailable');
    assert.equal(established.readiness.outbound, 'ready');
    assert.equal(established.readiness.stale, false);
    assert.match(established.readiness.reportedAt ?? '', /^20\d\d-/);
    assert.match(established.readiness.freshUntil ?? '', /^20\d\d-/);

    const now = Date.now;
    Date.now = () => now() + 16 * 60_000;
    try {
      assert.equal(
        manager.listCapabilities().find((connector) => connector.id === 'bootstrap')
          ?.readiness.stale,
        true,
      );
      const refreshed = await manager.executeReadProbe({
        connector: 'bootstrap',
        action: 'inspect',
        capability: 'fixture.read',
        target: 'bounded',
        payload: { limit: 2 },
      });
      assert.equal(refreshed.actionResult, true);
      assert.equal(
        manager.listCapabilities().find((connector) => connector.id === 'bootstrap')
          ?.readiness.stale,
        false,
      );
    } finally {
      Date.now = now;
    }

    await assert.rejects(() => manager.executeReadProbe({
      connector: 'unavailable',
      action: 'inspect',
      capability: 'fixture.read',
      target: 'bounded',
      payload: {},
    }), /not_ready|未就绪/i);
  } finally {
    await manager.stop();
    store.close();
  }
});
