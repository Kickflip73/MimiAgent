import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../src/config.js';
import { daemonWebBackend, type WebBackend } from '../src/web/backend.js';
import { MimiWebServer } from '../src/web/server.js';
import { MimiIpcServer } from '../src/daemon/ipc.js';

function backend(overrides: Partial<WebBackend> = {}): WebBackend {
  return {
    status: async () => ({ pid: 123 }), sessions: async () => [],
    session: async (id, draft) => ({ sessionId: id, draft, items: [] }),
    context: async () => ({}), history: async () => [], submit: async () => ({ eventId: 'task-1' }),
    stream: async () => ({ events: [], task: { id: 'task-1', status: 'completed', result: { answer: 'done' } } }),
    tasks: async () => [], task: async () => ({ taskId: 'task-1' }),
    taskAction: async (_id, action) => ({ state: action }),
    memory: async () => [], memoryRead: async () => ({ body: 'remembered' }),
    models: async () => ({ choices: [], current: {} }), model: async () => null,
    mode: async () => null, ...overrides,
  };
}
function localHeaders(server: MimiWebServer): Record<string, string> {
  return { origin: server.address, 'x-mimi-web': '1', 'content-type': 'application/json' };
}

test('Local Web opens directly without credentials, cookies or a connect handshake', async (t) => {
  const server = new MimiWebServer(backend(), 0); await server.start(); t.after(() => server.close());
  const page = await fetch(server.address); const html = await page.text();
  assert.match(html, /Mimi/);
  assert.equal(new URL(server.launchUrl).hash, '');
  assert.equal(page.headers.get('set-cookie'), null);
  assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  const browserHeaders: Array<Record<string, string>> = [{}, { cookie: 'mimi_web_old=expired' }];
  for (const headers of browserHeaders) {
    assert.equal((await fetch(`${server.address}/api/status`, { headers })).status, 200);
    assert.equal((await fetch(`${server.address}/api/sessions`, { headers })).status, 200);
  }
  assert.equal((await fetch(`${server.address}/api/mode`, { method: 'POST', headers: localHeaders(server), body: JSON.stringify({sessionId:'s', mode:'general'}) })).status, 200);
  assert.equal((await fetch(`${server.address}/api/connect`, { method: 'POST', headers: localHeaders(server), body: '{}' })).status, 404);
  assert.equal((await fetch(`${server.address}/package.json`)).status, 404);
  for (const asset of ['app.js', 'execution.js', 'pickers.js', 'manage.js']) assert.equal((await fetch(`${server.address}/${asset}`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
});

test('Web rejects cross-origin requests and DNS rebinding without a login requirement', async (t) => {
  let calls = 0;
  const server = new MimiWebServer(backend({ submit: async () => { calls++; return {}; } }), 0);
  await server.start(); t.after(() => server.close()); const headers = localHeaders(server);
  const invalidHeaders: Array<Record<string, string>> = [{ origin: 'https://example.com' }, { 'sec-fetch-site': 'cross-site' }, { origin: '' }, { 'x-mimi-web': '' }];
  for (const extra of invalidHeaders) {
    const r = await fetch(`${server.address}/api/messages`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify({ sessionId: 's', input: 'hello', requestId: randomUUID() }) });
    assert.equal(r.status, 403, JSON.stringify(extra));
  }
  const rebound = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(server.address + '/api/status', { headers: { ...headers, host: 'evil.example' } }, (res) => {
      res.resume(); resolve(res.statusCode);
    });
    req.on('error', reject); req.end();
  });
  assert.equal(rebound, 403);
  assert.equal(calls, 0);
});

test('Web validates inputs and exposes a fixed operation allowlist', async (t) => {
  const calls: unknown[] = [];
  const server = new MimiWebServer(backend({ submit: async (...args) => { calls.push(args); return { eventId: 'task-1' }; } }), 0);
  await server.start(); t.after(() => server.close()); const headers = localHeaders(server);
  const post = (route: string, value: unknown) => fetch(`${server.address}/api/${route}`, { method: 'POST', headers, body: JSON.stringify(value) });
  assert.equal((await post('messages', { sessionId: '../secret', input: 'hi', requestId: randomUUID() })).status, 400);
  assert.equal((await post('messages', { sessionId: 's', input: '', requestId: randomUUID() })).status, 400);
  assert.equal((await post('messages', { sessionId: 's', input: 'hello', requestId: 'bad' })).status, 400);
  assert.equal((await post('messages', { sessionId: 's', input: 'x'.repeat(300_000), requestId: randomUUID() })).status, 413);
  assert.equal((await post('invoke', { operation: 'shutdown' })).status, 404);
  assert.equal((await post('mode', { sessionId: 's', mode: 'owner-root' })).status, 400);
  const requestId = randomUUID();
  assert.equal((await post('messages', { sessionId: 's', input: 'hello', requestId })).status, 202);
  assert.deepEqual(calls, [['s', 'hello', requestId, undefined]]);
});

test('SSE resumes at Last-Event-ID and emits the authoritative terminal receipt', async (t) => {
  let cursor = -1;
  const server = new MimiWebServer(backend({ stream: async (_id, after) => {
    cursor = after;
    return { events: [{ sequence: 9, eventId: 'task-1', kind: 'answer', text: 'hello' }], nextSequence: 9, task: { id: 'task-1', status: 'completed', result: { answer: 'complete answer' } } };
  } }), 0);
  await server.start(); t.after(() => server.close()); const headers = localHeaders(server);
  const response = await fetch(`${server.address}/api/events?id=task-1&after=0`, { headers: { ...headers, 'last-event-id': '8' } });
  const stream = await response.text(); assert.equal(cursor, 8); assert.match(stream, /id: 9/); assert.match(stream, /event: done/); assert.match(stream, /complete answer/);
});

test('Closing a Web stream does not cancel the underlying task', async (t) => {
  let cancellations = 0;
  const server = new MimiWebServer(backend({ stream: async () => ({ events: [], task: { id: 'task-1', status: 'running' } }), taskAction: async () => { cancellations++; return {}; } }), 0);
  await server.start(); t.after(() => server.close()); const headers = localHeaders(server);
  const abort = new AbortController();
  const response = await fetch(`${server.address}/api/events?id=task-1`, { headers, signal: abort.signal });
  assert.equal(response.status, 200); abort.abort(); assert.equal(cancellations, 0);
});

test('Web reports missing tasks and unavailable daemon without successful-looking responses', async (t) => {
  const server = new MimiWebServer(backend({ status: async () => { throw new Error('daemon offline'); }, stream: async () => ({ events: [] }) }), 0);
  await server.start(); t.after(() => server.close()); const headers = localHeaders(server);
  assert.equal((await fetch(`${server.address}/api/status`, { headers })).status, 503);
  assert.equal((await fetch(`${server.address}/api/events?id=missing`, { headers })).status, 404);
});

test('Web backend routes through real IPC and preserves submit identity across HTTP retries', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-web-'));
  const requests: Array<Record<string, unknown>> = [];
  let archiveReads = 0;
  let snapshotReads = 0;
  const ipc = new MimiIpcServer(path.join(root, 'mimi.sock'), (method, params) => {
    if (method === 'chat.snapshot') { snapshotReads++; assert.equal((params as any).sessionKey, 'session-1'); return { sessionId: 'session-1', items: [], workspaceRoot: root, contextWindow: 1000, contextUsed: 50, contextStatus: { source: 'actual' } }; }
    if (method === 'chat.sessions') { archiveReads++; return [{ id: 'session-1' }]; }
    if (method === 'submit') { const value = params as Record<string, unknown>; requests.push(value); return { task: { id: value.eventId }, inserted: requests.length === 1 }; }
    if (method === 'tasks.pause') return { state: 'paused' };
    if (method === 'chat.invoke') { const p = params as Record<string, unknown>; if (p.operation === 'memory.list' || p.operation === 'memory.read') throw new Error('session execution lane must not serve the memory browser'); return { operation: p.operation }; }
    throw new Error(method);
  });
  await ipc.start(); t.after(async () => { await ipc.close(); await rm(root, { recursive: true, force: true }); });
  const client = daemonWebBackend({ workspaceRoot: root, dataRoot: root, daemonDataRoot: root } as AppConfig, { homeDirectory: root });
  await Promise.all([client.sessions(), client.sessions()]);
  await client.sessions();
  assert.equal(archiveReads, 1, 'multiple browser tabs share one archive scan');
  const requestId = randomUUID();
  const first = await client.submit('session-1', 'hello', requestId);
  const second = await client.submit('session-1', 'hello', requestId);
  assert.deepEqual(first, { eventId: requestId, inserted: true });
  assert.deepEqual(second, { eventId: requestId, inserted: false });
  assert.equal(requests[0]!.externalId, requests[1]!.externalId);
  assert.deepEqual(await client.taskAction('task-1', 'pause'), { state: 'paused' });
  await client.submit('session-1', 'restricted', randomUUID(), 'safe');
  assert.equal(requests.at(-1)!.requestedSecurityProfile, 'safe');
  const context = await client.context('session-1') as { contextWindow: number; estimatedTokens: number; detailAvailable: boolean };
  assert.equal(context.contextWindow, 1000); assert.equal(context.estimatedTokens, 50); assert.equal(context.detailAvailable, false);
  await client.session('session-1',false);
  const beforeMemory=snapshotReads;
  assert.deepEqual(await client.memory('session-1'), []);
  assert.equal(snapshotReads,beforeMemory,'memory browsing reuses the known workspace without an unrelated snapshot RPC');
  assert.equal(await client.memoryRead('session-1', 'private', 'mem_test'), undefined);
});


test('Web model selection validates provider targets and only changes the selected session', async (t) => {
  const calls: unknown[] = [];
  const server = new MimiWebServer(backend({ model: async (...args) => { calls.push(args); return { effective: 'next_run' }; } }), 0);
  await server.start(); t.after(() => server.close()); const headers = localHeaders(server);
  const post = (target: unknown) => fetch(`${server.address}/api/model`, { method: 'POST', headers, body: JSON.stringify({ sessionId: 'session-1', target }) });
  assert.equal((await post({ providerId: 'test', modelId: 'test-model' })).status, 200);
  assert.equal((await post(null)).status, 200);
  assert.equal((await post({ providerId: 'test', modelId: '', apiKey: 'forbidden' })).status, 400);
  assert.equal((await post(undefined)).status, 400);
  assert.deepEqual(calls, [['session-1', { providerId: 'test', modelId: 'test-model' }], ['session-1', null]]);
  assert.equal((await fetch(`${server.address}/api/models?session=session-1`, { headers })).status, 200);
});

test('Web run reconciliation uses foreground event state, including missing and terminal tasks', async (t) => {
  const server = new MimiWebServer(backend({ stream: async (id) => ({ events: [], ...(id === 'missing' ? {} : { task: { id, status: 'completed', result: { answer: 'saved answer' } } }) }) }), 0);
  await server.start(); t.after(() => server.close()); const headers = localHeaders(server);
  const result = await fetch(`${server.address}/api/run?id=event-1`, { headers });
  assert.deepEqual(await result.json(), { id: 'event-1', status: 'completed', result: { answer: 'saved answer' } });
  assert.equal((await fetch(`${server.address}/api/run?id=missing`, { headers })).status, 404);
});


test('Web forwards per-run security and exposes session-scoped context details', async (t) => {
  const calls: unknown[] = [];
  const server = new MimiWebServer(backend({
    submit: async (...args) => { calls.push(args); return { eventId: 'run-1' }; },
    context: async (id) => ({ sessionId: id, contextWindow: 1000, sections: [{ id: 'recent-history', estimatedTokens: 100 }] }),
  }), 0);
  await server.start(); t.after(() => server.close());
  const headers = localHeaders(server), requestId = randomUUID();
  const post = (security: string) => fetch(`${server.address}/api/messages`, { method: 'POST', headers, body: JSON.stringify({ sessionId: 's', input: 'hi', requestId, security }) });
  assert.equal((await post('root')).status, 400);
  assert.equal((await post('safe')).status, 202);
  assert.deepEqual(calls, [['s', 'hi', requestId, 'safe']]);
  const response = await fetch(`${server.address}/api/context?session=s`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).sections[0].estimatedTokens, 100);
  assert.equal((await fetch(`${server.address}/api/context?session=../private`)).status, 400);
});


test('progress fallback pages replay missing events before the final receipt, independent of SSE', async(t)=>{
  const server=new MimiWebServer(backend({stream:async(_id,after)=>({events:after<2?[{sequence:2,eventId:'run',kind:'answer',text:'replayed'}]:[],nextSequence:2,hasMore:after<2,task:{id:'run',status:'completed',result:{answer:'final'}}})}),0);
  await server.start();t.after(()=>server.close());
  const page=await (await fetch(`${server.address}/api/progress?id=run&after=0`)).json() as any;
  assert.equal(page.events[0].text,'replayed');assert.equal(page.hasMore,true);
  const tail=await (await fetch(`${server.address}/api/progress?id=run&after=2`)).json() as any;
  assert.equal(tail.events.length,0);assert.equal(tail.task.status,'completed');
  assert.equal((await fetch(`${server.address}/api/progress?id=run&after=-1`)).status,400);
});


test('SSE forwards consecutive live batches without the former 750ms gate', async (t) => {
  let polls = 0;
  const at: number[] = [];
  const server = new MimiWebServer(backend({ stream: async () => {
    at.push(performance.now()); polls++;
    return { events: [{ sequence: polls, eventId: 'paced', kind: 'answer', text: '字' }], nextSequence: polls,
      task: { id: 'paced', status: polls >= 3 ? 'completed' : 'running', result: { answer: '字字字' } } };
  } }), 0);
  await server.start(); t.after(() => server.close());
  const response = await fetch(`${server.address}/api/events?id=paced`);
  const content = await response.text();
  assert.match(response.headers.get('cache-control')!, /no-transform/);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  assert.equal((content.match(/event: update/g) || []).length, 3);
  assert.ok(at[2]! - at[0]! < 650, 'new batches should not wait on a 750ms poll interval');
});

test('Web accepts binary image upload and image-only messages without passing image bytes through IPC',async t=>{
  const id='a'.repeat(64)+'.png',calls:unknown[][]=[];
  const server=new MimiWebServer(backend({uploadImage:async(data,mediaType)=>({id,bytes:data.length,mediaType}),
    image:async()=>({data:Buffer.from('image bytes'),mediaType:'image/png'}),submit:async(...args)=>{calls.push(args);return {eventId:'task'};}}),0);
  await server.start();t.after(()=>server.close());
  const upload=await fetch(server.address+'/api/images',{method:'POST',headers:{...localHeaders(server),'content-type':'image/png'},body:Buffer.alloc(300_000,1)});
  assert.equal(upload.status,201);assert.equal((await upload.json() as any).bytes,300_000);
  const response=await fetch(server.address+'/api/messages',{method:'POST',headers:localHeaders(server),body:JSON.stringify({sessionId:'s',input:'',requestId:randomUUID(),images:[id]})});
  assert.equal(response.status,202);assert.deepEqual(calls[0]![5],[id]);
  const preview=await fetch(server.address+'/api/images?id='+id);assert.equal(preview.headers.get('content-type'),'image/png');
  const blocked=await fetch(server.address+'/api/images',{method:'POST',headers:{'content-type':'image/png',origin:'https://evil.test'},body:'image'});
  assert.equal(blocked.status,403);
});
