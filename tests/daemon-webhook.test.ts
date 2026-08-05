import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MimiStore } from '../src/daemon/store.js';
import { MimiWebhookServer } from '../src/daemon/webhook.js';

function request(
  address: string,
  method: string,
  route: string,
  token?: string,
  body?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(route, address);
    const req = http.request({
      hostname: url.hostname,
      port: Number(url.port),
      path: url.pathname,
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      }));
    });
    req.once('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('webhook health, authorization, validation, routing and deduplication are bounded', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-webhook-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const token = 'test-token-with-at-least-24-characters';
  const server = new MimiWebhookServer(store, 0, token);
  try {
    await server.start();
    await server.start();
    const address = server.address;
    assert.ok(address);
    assert.deepEqual(await request(address, 'GET', '/health'), { status: 200, body: { ok: true } });
    assert.equal((await request(address, 'GET', '/missing')).status, 404);
    assert.equal((await request(address, 'POST', '/v1/events', undefined, '{}')).status, 401);
    assert.equal((await request(address, 'POST', '/v1/events', 'wrong-token', '{}')).status, 401);
    assert.equal((await request(address, 'POST', '/v1/events', token, '{')).status, 400);

    const input = JSON.stringify({
      externalId: 'webhook-event-1',
      channel: 'ci',
      kind: 'command',
      payload: { status: 'complete' },
      priority: 80,
      actor: { id: 'build-system', displayName: 'Build' },
      conversation: { id: 'job-1', threadId: 'attempt-1' },
      reply: { connector: 'mail', target: 'owner' },
    });
    const accepted = await request(address, 'POST', '/v1/events', token, input);
    assert.equal(accepted.status, 202);
    assert.equal(accepted.body.inserted, true);
    assert.equal(accepted.body.decision, 'task_created');
    const duplicate = await request(address, 'POST', '/v1/events', token, input);
    assert.equal(duplicate.status, 202);
    assert.equal(duplicate.body.inserted, false);
    assert.equal(store.activitySnapshot(10).tasks.queued, 1);

    const digest = await request(address, 'POST', '/v1/events', token, JSON.stringify({
      externalId: 'webhook-event-2',
      payload: { status: 'ambient' },
      notify: false,
    }));
    assert.equal(digest.status, 202);
    assert.equal(digest.body.decision, 'task_created');
  } finally {
    await server.close();
    await server.close();
    store.close();
  }
});

test('webhook constructor rejects unsafe endpoint configuration', () => {
  assert.throws(() => new MimiWebhookServer({} as MimiStore, -1, 'x'.repeat(24)), /PORT/);
  assert.throws(() => new MimiWebhookServer({} as MimiStore, 1, 'short'), /TOKEN/);
});
