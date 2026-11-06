import assert from 'node:assert/strict';
import test from 'node:test';
import { RunContext } from '@openai/agents';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { createTools } from '../src/tools.js';
import { HostCapabilityRegistry } from '../src/runtime/pipeline/capability-registry.js';
import { ToolSetBuilder } from '../src/runtime/pipeline/tool-set-builder.js';
import { toolsForMode, toolsForSecurity } from '../src/runtime/tool-policy.js';

test('portable search requires complete explicit configuration; hosted search remains available', () => {
  const previous = { key: process.env.GOOGLE_CSE_API_KEY, cx: process.env.GOOGLE_CSE_CX };
  try {
    for (const [key, cx] of [['', ''], ['fixture-key', ''], ['', 'fixture-cx'], ['  ', 'fixture-cx']]) {
      process.env.GOOGLE_CSE_API_KEY = key;
      process.env.GOOGLE_CSE_CX = cx;
      assert.equal(createTools(process.cwd(), false).some(tool => tool.name === 'web_search'), false);
      const hosted = createTools(process.cwd(), true).find(tool => tool.name === 'web_search');
      assert.ok(hosted);
      assert.notEqual(hosted.type, 'function');
    }
    process.env.GOOGLE_CSE_API_KEY = 'fixture-key';
    process.env.GOOGLE_CSE_CX = 'fixture-cx';
    assert.equal(createTools(process.cwd(), false).find(tool => tool.name === 'web_search')?.type, 'function');
    assert.notEqual(createTools(process.cwd(), true).find(tool => tool.name === 'web_search')?.type, 'function');
  } finally {
    if (previous.key === undefined) delete process.env.GOOGLE_CSE_API_KEY;
    else process.env.GOOGLE_CSE_API_KEY = previous.key;
    if (previous.cx === undefined) delete process.env.GOOGLE_CSE_CX;
    else process.env.GOOGLE_CSE_CX = previous.cx;
  }
});

test('configured search uses only the configured API and never falls back after failure or empty results', async () => {
  const previous = { key: process.env.GOOGLE_CSE_API_KEY, cx: process.env.GOOGLE_CSE_CX };
  const dispatcher = getGlobalDispatcher();
  const mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
  process.env.GOOGLE_CSE_API_KEY = 'fixture-key';
  process.env.GOOGLE_CSE_CX = 'fixture-cx';
  try {
    const search = createTools(process.cwd(), false).find(tool => tool.name === 'web_search');
    assert.ok(search?.type === 'function');
    const pool = mock.get('https://www.googleapis.com');
    for (const [query, status, body] of [
      ['success', 200, { items: [{ title: 'Fixture source', link: 'https://example.com/source', snippet: 'Evidence' }] }],
      ['empty', 200, {}],
      ['failed', 503, { error: 'unavailable' }],
    ] as const) {
      pool.intercept({ path: `/customsearch/v1?key=fixture-key&cx=fixture-cx&q=${query}&num=3` })
        .reply(status, body);
      const result = await search.invoke(new RunContext({}), JSON.stringify({ query, num: 3 }));
      assert.match(JSON.stringify(result), query === 'success' ? /Fixture source/ : query === 'empty' ? /未找到结果/ : /Google CSE 返回 503/);
    }
    mock.assertNoPendingInterceptors();
  } finally {
    setGlobalDispatcher(dispatcher);
    await mock.close();
    if (previous.key === undefined) delete process.env.GOOGLE_CSE_API_KEY;
    else process.env.GOOGLE_CSE_API_KEY = previous.key;
    if (previous.cx === undefined) delete process.env.GOOGLE_CSE_CX;
    else process.env.GOOGLE_CSE_CX = previous.cx;
  }
});

test('http_get is deferred in every mode, remains discoverable and preserves private-network denial', async () => {
  const builder = new ToolSetBuilder();
  for (const mode of ['general', 'plan', 'ultra'] as const) {
    const authorized = toolsForMode(mode, toolsForSecurity('safe', createTools(process.cwd(), false)));
    // A policy allowlist grants access, not direct disclosure.
    const classified = builder.classify(authorized, { allowedCapabilities: ['network-read'], allowedTools: ['http_get'] }, ['http_get']);
    assert.equal(classified.direct.some(tool => tool.name === 'http_get'), false);
    assert.ok(classified.deferred.some(tool => tool.name === 'http_get'));
    const registry = new HostCapabilityRegistry(authorized);
    const gateways = registry.gatewayTools(classified.deferred);
    const inspect = gateways.find(tool => tool.name === 'inspect_capabilities');
    const invoke = gateways.find(tool => tool.name === 'invoke_capability');
    assert.ok(inspect?.type === 'function' && invoke?.type === 'function');
    const found = await inspect.invoke(new RunContext({}), '{"name":"http_get"}') as {
      resolution: { status: string }; capabilities: Array<{ invokeWith: string }>;
    };
    assert.equal(found.resolution.status, 'deferred');
    assert.equal(found.capabilities[0]?.invokeWith, 'invoke_capability');
    const denied = await invoke.invoke(new RunContext({}), JSON.stringify({
      name: 'http_get', argumentsJson: '{"url":"http://127.0.0.1/"}',
    }));
    assert.match(JSON.stringify(denied), /只允许访问公网地址/);
    const snapshot = registry.snapshot({ runId: mode, policyRevision: 'fixture', modelTools: builder.sdkTools(classified, gateways) });
    assert.equal(snapshot.tools.includes('http_get'), false);
    assert.ok(snapshot.hiddenTools.some(group => group.names.includes('http_get')));
  }
});
