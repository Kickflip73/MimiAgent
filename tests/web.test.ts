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
  let sessionsRefresh: boolean | undefined;
  const server = new MimiWebServer(backend({ sessions: async (refresh) => { sessionsRefresh = refresh; return []; } }), 0); await server.start(); t.after(() => server.close());
  const page = await fetch(server.address); const html = await page.text();
  assert.match(html, /Mimi/);
  assert.equal(new URL(server.launchUrl).hash, '');
  assert.equal(page.headers.get('set-cookie'), null);
  assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  const browserHeaders: Array<Record<string, string>> = [{}, { cookie: 'mimi_web_old=expired' }];
  for (const headers of browserHeaders) {
    assert.equal((await fetch(`${server.address}/api/status`, { headers })).status, 200);
    assert.equal((await fetch(`${server.address}/api/sessions`, { headers })).status, 200);
    assert.equal(sessionsRefresh, false);
  }
  assert.equal((await fetch(`${server.address}/api/sessions?refresh=1`, { headers: {} })).status, 200);
  assert.equal(sessionsRefresh, true, '?refresh=1 bypasses the archive TTL cache');
  assert.equal((await fetch(`${server.address}/api/mode`, { method: 'POST', headers: localHeaders(server), body: JSON.stringify({sessionId:'s', mode:'general'}) })).status, 200);
  assert.equal((await fetch(`${server.address}/api/connect`, { method: 'POST', headers: localHeaders(server), body: '{}' })).status, 404);
  assert.equal((await fetch(`${server.address}/package.json`)).status, 404);
  for (const asset of ['app.js', 'execution.js', 'pickers.js', 'manage.js', 'uuid.js']) assert.equal((await fetch(`${server.address}/${asset}`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
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
  await client.sessions(true);
  assert.equal(archiveReads, 2, 'a forced list refresh bypasses the archive TTL cache');
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

test('media upload, media-only submission and byte-range playback preserve attachment identity',async t=>{
 const {mediaAttachment}=await import('../src/core/media-attachment.js');
 const data=Buffer.from('RIFF0000WAVEfmt synthetic test payload');const ref=mediaAttachment(data,'audio/wav');let submitted:unknown[]=[];
 const server=new MimiWebServer(backend({uploadMedia:async(bytes,type)=>mediaAttachment(bytes,type),media:async()=>({data,mediaType:'audio/wav'}),prepareMedia:async()=>({...ref,transcript:'你好'}),submit:async(...args)=>{submitted=args;return {eventId:'media-task'};}}),0);
 await server.start();t.after(()=>server.close());const headers=localHeaders(server);
 const upload=await fetch(server.address+'/api/media',{method:'POST',headers:{...headers,'content-type':'audio/wav'},body:data});assert.equal(upload.status,201);assert.equal((await upload.json() as any).id,ref.id);
 for(const [range,expected,status] of [['bytes=0-3','RIFF',206],['bytes=-7','payload',206],['bytes=999-1000','',416]] as const){const response=await fetch(server.address+'/api/media?id='+ref.id,{headers:{range}});assert.equal(response.status,status);if(expected)assert.equal(await response.text(),expected);}
 const result=await fetch(server.address+'/api/messages',{method:'POST',headers,body:JSON.stringify({sessionId:'s',input:'',requestId:randomUUID(),media:[ref.id]})});assert.equal(result.status,202);assert.deepEqual(submitted[6],[ref.id]);
 assert.equal((await fetch(server.address+'/api/media',{method:'POST',headers:{...headers,origin:'https://evil.example'},body:data})).status,403);
});

test('notification inbox remains available while daemon is unavailable, validates paging and protects read receipts', async t => {
  const {WebNotifications}=await import('../src/web/notifications.js');
  const root=await mkdtemp(path.join(os.tmpdir(),'mimi-notice-http-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const server=new MimiWebServer(backend({status:async()=>{throw new Error('offline');},notifications:new WebNotifications(path.join(root,'absent.db'),path.join(root,'read.json'))}),0);
  await server.start();t.after(()=>server.close());
  assert.equal((await fetch(`${server.address}/api/notifications`)).status,200);
  assert.equal((await fetch(`${server.address}/notifications.js`)).status,200);
  assert.equal((await fetch(`${server.address}/api/notifications?before=NaN`)).status,400);
  assert.equal((await fetch(`${server.address}/api/notifications?id=missing`)).status,404);
  assert.equal((await fetch(`${server.address}/api/notifications/read`,{method:'POST',headers:{'content-type':'application/json'},body:'{"through":0}'})).status,403);
  const request={method:'POST',headers:localHeaders(server),body:'{"through":0}'};
  assert.equal((await fetch(`${server.address}/api/notifications/read`,request)).status,200);
  assert.equal((await fetch(`${server.address}/api/notifications/read`,{...request,body:'{"through":-1}'})).status,400);
});


test('Web accepts only the configured hostname alias with its own exact origin', async (t) => {
  let calls = 0;
  const server = new MimiWebServer(backend({ mode: async () => { calls++; return {}; } }), 0, 'mimi.com');
  await server.start(); t.after(() => server.close());
  const port = new URL(server.address).port;
  const host = `mimi.com:${port}`;
  assert.equal(server.launchUrl, `http://${host}/`);
  const send = (method: string, headers: Record<string, string>) => new Promise<number | undefined>((resolve, reject) => {
    const req = request(`${server.address}${method === 'POST' ? '/api/mode' : '/'}`, { method, headers }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(method === 'POST' ? JSON.stringify({ sessionId: 's', mode: 'general' }) : undefined);
  });
  assert.equal(await send('GET', { host }), 200);
  assert.equal((await fetch(server.address)).status, 200);
  const headers = { host, origin: `http://${host}`, 'x-mimi-web': '1', 'content-type': 'application/json' };
  assert.equal(await send('POST', headers), 200);
  const invalidOrigins: Array<Record<string, string>> = [{ origin: server.address }, { origin: 'https://' + host }, { origin: 'http://mimi.com' }, { 'sec-fetch-site': 'cross-site' }];
  for (const extra of invalidOrigins) {
    assert.equal(await send('POST', { ...headers, ...extra }), 403);
  }
  for (const invalid of ['evil.com', `www.${host}`, `mimi.com:${Number(port) + 1}`, `mimi.com.evil:${port}`]) {
    assert.equal(await send('GET', { host: invalid }), 403);
  }
  assert.equal(calls, 1);
});

test('Web rejects hostname aliases containing URL components or wildcards', () => {
  for (const hostname of ['', '*', '*.mimi.com', 'http://mimi.com', 'mimi.com:3210', 'mimi.com/path', 'user@mimi.com', '-mimi.com', 'mimi..com']) {
    assert.throws(() => new MimiWebServer(backend(), 0, hostname), /Web 域名无效/);
  }
});


test('Web supports a portless reverse proxy origin without trusting forwarded headers', async (t) => {
  let calls = 0;
  const server = new MimiWebServer(backend({ mode: async () => { calls++; return {}; } }), 0, 'mimi.com', 80);
  await server.start(); t.after(() => server.close());
  assert.equal(server.launchUrl, 'http://mimi.com/');
  const send = (headers: Record<string, string>) => new Promise<number | undefined>((resolve, reject) => {
    const req = request(`${server.address}/api/mode`, { method: 'POST', headers: {
      host: 'mimi.com', origin: 'http://mimi.com', 'x-mimi-web': '1', 'content-type': 'application/json', ...headers,
    } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end(JSON.stringify({ sessionId: 's', mode: 'general' }));
  });
  assert.equal(await send({}), 200);
  assert.equal(await send({ origin: server.address }), 403);
  assert.equal(await send({ host: 'evil.com', 'x-forwarded-host': 'mimi.com' }), 403);
  assert.equal(await send({ origin: 'http://evil.com', 'x-forwarded-proto': 'http' }), 403);
  assert.equal(await send({ host: `mimi.com:${new URL(server.address).port}` }), 403);
  assert.equal(calls, 1);
  for (const port of [0, -1, 65536, NaN, 1.5]) {
    assert.throws(() => new MimiWebServer(backend(), 0, 'mimi.com', port), /Web 外部端口无效/);
  }
  assert.throws(() => new MimiWebServer(backend(), 0, undefined, 80), /Web 外部端口无效/);
});


test('Web allows incoming document links but keeps cross-site API and embedded requests blocked', async (t) => {
  const server = new MimiWebServer(backend(), 0);
  await server.start(); t.after(() => server.close());
  const get = (route: string, extra: Record<string, string> = {}) => new Promise<number | undefined>((resolve, reject) => {
    const req = request(server.address + route, { headers: {
      'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', ...extra,
    } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(await get('/'), 200);
  assert.equal(await get('/?session=test'), 200);
  assert.equal(await get('/api/status'), 403);
  assert.equal(await get('/api/sessions'), 403);
  assert.equal(await get('/app.js'), 403);
  assert.equal(await get('/', { 'sec-fetch-mode': 'cors' }), 403);
  assert.equal(await get('/', { 'sec-fetch-dest': 'iframe' }), 403);
  assert.equal(await get('/', { host: 'evil.example' }), 403);
});

test('speech forwards the first PCM chunk before generation completes and cancels on disconnect', async (t) => {
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled!: () => void;
  const cancellation = new Promise<void>(resolve => { cancelled = resolve; });
  const server = new MimiWebServer(backend({ speechStream: async (_text, signal) => {
    signal.addEventListener('abort', cancelled, { once: true });
    return new Response(new ReadableStream({ start(c) { streamController = c; c.enqueue(new Uint8Array([1, 0])); } }),
      { headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '24000', 'x-sample-format': 's16le' } });
  } }), 0);
  await server.start(); t.after(() => server.close());
  const controller = new AbortController();
  const response = await fetch(`${server.address}/api/speech/stream`, { method: 'POST', headers: localHeaders(server),
    body: JSON.stringify({ text: '你好' }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]) });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.body!.getReader().read()).value, new Uint8Array([1, 0]));
  assert.ok(streamController, 'upstream is still open when first audio arrives');
  controller.abort();
  await Promise.race([cancellation, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('disconnect not propagated')), 2000); timer.unref(); })]);
});

test('speech validates origin and text before invoking the synthesizer', async (t) => {
  let calls = 0;
  const server = new MimiWebServer(backend({ speechStream: async () => { calls++; throw new Error('busy'); } }), 0);
  await server.start(); t.after(() => server.close());
  for (const [text, origin, status] of [['hello', 'http://evil.example', 403], ['', server.address, 400], ['x'.repeat(10001), server.address, 400]] as const) {
    const response = await fetch(`${server.address}/api/speech/stream`, { method: 'POST',
      headers: { ...localHeaders(server), origin }, body: JSON.stringify({ text }) });
    assert.equal(response.status, status);
  }
  assert.equal(calls, 0);
});

test('speech settings share protected management and reject removed engines before synthesis', async t => {
  const actions: string[] = [];
  let calls = 0;
  const server = new MimiWebServer(backend({ speechManage: async (action, value) => { actions.push(action); return { value }; },
    speechStream: async (_text, _signal, options) => { calls++; assert.equal(options?.engine, 'macos'); return new Response('wav-fixture', { headers: { 'content-type': 'audio/wav' } }); } }), 0);
  await server.start(); t.after(() => server.close());
  assert.equal((await fetch(`${server.address}/api/speech/settings`)).status, 200);
  const post = (route: string, value: unknown, headers = localHeaders(server)) => fetch(server.address + route, { method: 'POST', headers, body: JSON.stringify(value) });
  assert.equal((await post('/api/speech/settings', { action: 'configure', value: { engine: 'macos' } })).status, 200);
  assert.equal((await post('/api/speech/settings', { action: 'voice_remove', value: 'x' }, { ...localHeaders(server), origin: 'http://evil.example' })).status, 403);
  assert.deepEqual(actions, ['settings', 'configure']);
  assert.equal((await post('/api/speech/stream', { text: 'hello', options: { engine: 'chattts' } })).status, 400);
  assert.equal(calls, 0);
  const audio = await post('/api/speech/stream', { text: 'hello', options: { engine: 'macos' } });
  assert.equal(audio.headers.get('content-type'), 'audio/wav');
  assert.equal(await audio.text(), 'wav-fixture');
});

test('live speech reads an existing render without synthesis and rejects cross-site access', async t => {
  let renders = 0, reads = 0;
  const server = new MimiWebServer(backend({
    speechStream: async () => { renders++; throw new Error('must not synthesize'); },
    speechLive: async (session, id) => {
      reads++; assert.equal(session, 'story'); assert.equal(id, '93355172-3311-421c-a6e2-ecf910572ad5');
      return new Response(new Uint8Array([0, 64]), { headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '24000', 'x-sample-format': 's16le' } });
    },
  }), 0);
  await server.start(); t.after(() => server.close());
  const url = `${server.address}/api/speech/live?session=story&id=93355172-3311-421c-a6e2-ecf910572ad5`;
  assert.equal((await fetch(url, { headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal(reads, 0);
  const response = await fetch(url);
  assert.equal(response.status, 200); assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0, 64]));
  assert.equal(reads, 1); assert.equal(renders, 0);
});

test('explicit HTTPS proxy origin permits HTTPS mutations without trusting forwarded headers or HTTP origins', async t=>{
 let calls=0;
 const server=new MimiWebServer(backend({mode:async()=>{calls++;return {};}}),0,'mimi.com',443,'https');
 await server.start();t.after(()=>server.close());
 assert.equal(server.launchUrl,'https://mimi.com/');
 const send=(headers:Record<string,string>)=>new Promise<number|undefined>((resolve,reject)=>{
  const req=request(server.address+'/api/mode',{method:'POST',headers:{host:'mimi.com',origin:'https://mimi.com','x-mimi-web':'1','content-type':'application/json',...headers}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
  req.on('error',reject);req.end(JSON.stringify({sessionId:'s',mode:'general'}));
 });
 assert.equal(await send({}),200);
 assert.equal(await send({origin:'http://mimi.com','x-forwarded-proto':'https'}),403);
 assert.equal(await send({host:'evil.com','x-forwarded-host':'mimi.com'}),403);
 assert.equal(calls,1);
 assert.throws(()=>new MimiWebServer(backend(),0,'mimi.com',443,'ftp'),/外部协议/);
 assert.throws(()=>new MimiWebServer(backend(),0,undefined,undefined,'https'),/外部协议/);
});

test('voice preview audio is read-only, same-origin and never triggers synthesis', async t => {
  let reads = 0, writes = 0;
  const server = new MimiWebServer(backend({
    speechPreview: async id => { reads++; assert.equal(id, 'preview-1'); return Buffer.from('RIFF preview'); },
    speechManage: async () => { writes++; return {}; },
  }), 0);
  await server.start(); t.after(() => server.close());
  const url = server.address + '/api/speech/preview?id=preview-1';
  const result = await fetch(url); assert.equal(result.status, 200); assert.equal(result.headers.get('content-type'), 'audio/wav');
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(url, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(server.address + '/api/speech/preview?id=../secrets')).status, 400);
  assert.equal(reads, 1); assert.equal(writes, 0);
});
