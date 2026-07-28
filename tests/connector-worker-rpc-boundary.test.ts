import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  KernelConnectorRuntime,
  WORKER_CONNECTOR_ACTION_METHOD,
  WORKER_CONNECTOR_INSPECT_METHOD,
  connectorCapabilitySnapshotSchema,
  workerConnectorActionParamsSchema,
  workerConnectorFilterSchema,
  workerConnectorInspectParamsSchema,
} from '../src/daemon/connector-worker-rpc.js';
import { MimiIpcServer } from '../src/daemon/ipc.js';

const TASK_ID = '00000000-0000-4000-8000-000000000001';
const WORKER_TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGH123456789';

test('worker connector schemas reject ambiguous identifiers and oversized catalogs', () => {
  assert.deepEqual(workerConnectorFilterSchema.parse({ connector: 'mail', query: 'owner' }), {
    connector: 'mail',
    query: 'owner',
  });
  assert.throws(() => workerConnectorFilterSchema.parse({ connector: 'mail/unsafe' }));
  assert.throws(() => workerConnectorInspectParamsSchema.parse({
    taskId: 'not-a-uuid',
    workerToken: WORKER_TOKEN,
    filter: {},
  }));
  assert.throws(() => workerConnectorActionParamsSchema.parse({
    taskId: TASK_ID,
    workerToken: WORKER_TOKEN,
    request: { connector: 'mail', action: 'send', target: '', payload: {} },
  }));
  const base = {
    configFile: '/fixture/connectors.json',
    total: 1,
    enabled: 1,
    online: 1,
    inboundReady: 1,
    outboundReady: 1,
    stale: 0,
    actions: 101,
    truncated: false,
    connectors: [{
      id: 'mail',
      enabled: true,
      online: true,
      readiness: { inbound: 'ready', outbound: 'ready' },
      source: 'fixture:mail',
      actions: Array.from({ length: 101 }, (_, index) => ({
        name: `action-${index}`,
        description: 'action',
      })),
    }],
  };
  assert.throws(() => connectorCapabilitySnapshotSchema.parse(base), /100/);
});

test('kernel connector runtime sends exact worker authorization without control credentials', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-worker-connector-rpc-'));
  const socket = path.join(root, 'mimi.sock');
  const seen: Array<{ method: string; params: unknown; auth: string | undefined }> = [];
  const server = new MimiIpcServer(socket, (method, params, _signal, auth) => {
    seen.push({ method, params, auth });
    if (method === WORKER_CONNECTOR_INSPECT_METHOD) {
      return {
        configFile: '/fixture/connectors.json',
        total: 1,
        enabled: 1,
        online: 1,
        inboundReady: 1,
        outboundReady: 1,
        stale: 0,
        actions: 1,
        truncated: false,
        connectors: [{
          id: 'mail',
          enabled: true,
          online: true,
          readiness: { inbound: 'ready', outbound: 'ready' },
          source: 'fixture:mail',
          actions: [{ name: 'inspect', description: 'inspect' }],
        }],
      };
    }
    if (method === WORKER_CONNECTOR_ACTION_METHOD) return { outcome: 'accepted', operationId: 'op-1' };
    throw new Error('unexpected method');
  });
  await server.start();
  try {
    const runtime = new KernelConnectorRuntime(socket, TASK_ID, WORKER_TOKEN);
    const snapshot = await runtime.inspectCapabilities({ query: 'mail' });
    assert.equal(snapshot.total, 1);
    assert.deepEqual(await runtime.executeAction({
      connector: 'mail',
      action: 'inspect',
      target: 'owner',
      payload: { bounded: true },
    }), { outcome: 'accepted', operationId: 'op-1' });
    assert.deepEqual(seen.map((item) => item.method), [
      WORKER_CONNECTOR_INSPECT_METHOD,
      WORKER_CONNECTOR_ACTION_METHOD,
    ]);
    assert.equal(seen.every((item) => item.auth === undefined), true);
    assert.equal((seen[0]?.params as { taskId?: string }).taskId, TASK_ID);
    assert.equal((seen[1]?.params as { workerToken?: string }).workerToken, WORKER_TOKEN);
  } finally {
    await server.close();
  }
});

test('kernel connector runtime fails closed on invalid identity, socket, and broker response', async () => {
  assert.throws(() => new KernelConnectorRuntime('/socket', 'invalid', WORKER_TOKEN));
  assert.throws(() => new KernelConnectorRuntime('/socket', TASK_ID, 'invalid'));
  assert.throws(() => new KernelConnectorRuntime(' ', TASK_ID, WORKER_TOKEN), /socket/);

  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-worker-connector-invalid-'));
  const socket = path.join(root, 'mimi.sock');
  const server = new MimiIpcServer(socket, () => ({ total: 'invalid' }));
  await server.start();
  try {
    const runtime = new KernelConnectorRuntime(socket, TASK_ID, WORKER_TOKEN);
    await assert.rejects(runtime.inspectCapabilities({}), /Invalid input|expected/i);
  } finally {
    await server.close();
  }
});
