import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import type { AppConfig } from '../src/config.js';
import { configureAgentRuntime } from '../src/runtime/bootstrap.js';
import { BreezeTtsClient } from '../src/runtime/breeze-tts.js';

test('Agent runtime preserves native multipart audio uploads and error details', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests: Array<{ type: string; body: Buffer }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ type: String(request.headers['content-type']), body: Buffer.concat(chunks) });
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'reference is too long', code: 'voice_too_long' }));
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  configureAgentRuntime({} as AppConfig);
  const client = new BreezeTtsClient(`http://127.0.0.1:${address.port}`);
  const audio = Buffer.from('RIFF\x00\x01\x02WAVE');
  let failure = '';
  try { await client.registerVoiceAudio('test_voice', audio, '你好，世界'); }
  catch (error) { failure = (error as Error).message; }
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.type, /^multipart\/form-data; boundary=/);
  assert.ok(requests[0]!.body.includes(audio));
  assert.match(requests[0]!.body.toString(), /name="ref_audio"; filename="reference.wav"/);
  assert.match(requests[0]!.body.toString(), /你好，世界/);
  assert.match(failure, /HTTP 400.*voice_too_long/);
  await assert.rejects(client.stream({ text: 'hello', referenceAudio: { audio, text: '你好，世界' }, timeoutMs: 1000 }), /HTTP 400/);
  assert.match(requests[1]!.type, /^multipart\/form-data; boundary=/);
  assert.ok(requests[1]!.body.includes(audio));
  await fetch(`http://127.0.0.1:${address.port}`, { method: 'POST', body: new URLSearchParams({ text: '你好' }) });
  assert.match(requests[2]!.type, /^application\/x-www-form-urlencoded/);
  assert.equal(new URLSearchParams(requests[2]!.body.toString()).get('text'), '你好');
  await fetch(`http://127.0.0.1:${address.port}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"你好"}' });
  assert.equal(requests[3]!.type, 'application/json');
  assert.equal(requests[3]!.body.toString(), '{"text":"你好"}');
});
