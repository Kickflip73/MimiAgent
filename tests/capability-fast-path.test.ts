import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext, type MCPServer } from '@openai/agents';
import { z } from 'zod';
import { tool } from '../src/tool-factory.js';
import { MCPManager } from '../src/extensions/mcp.js';
import { HostCapabilityRegistry } from '../src/runtime/pipeline/capability-registry.js';
import { materializeMcpTools } from '../src/runtime/mcp-ledger.js';
import { ExecutionLedger } from '../src/core/execution-ledger.js';

const context = new RunContext({});
function gateways(registry: HostCapabilityRegistry) {
  return registry.gatewayTools(registry.authorizedTools()) as Array<ReturnType<typeof tool>>;
}

test('known authorized tools work in a fresh Run without discovery and still validate current schema', async () => {
  let executions = 0;
  const candidate = tool({ name: 'fixture_known', description: 'known tool', parameters: z.object({ value: z.string() }), execute: async ({ value }) => { executions += 1; return value; } });
  for (let run = 0; run < 2; run += 1) {
    const [, invoke] = gateways(new HostCapabilityRegistry([candidate]));
    assert.equal(await invoke!.invoke(context, JSON.stringify({ name: candidate.name, argumentsJson: '{"value":"ok"}' })), 'ok');
    const rejected = await invoke!.invoke(context, JSON.stringify({ name: candidate.name, argumentsJson: '{"value":42}' })) as any;
    assert.equal(rejected.code, 'tool_input_invalid');
  }
  assert.equal(executions, 2);
  const [, denied] = gateways(new HostCapabilityRegistry([]));
  assert.match(String(await denied!.invoke(context, JSON.stringify({ name: candidate.name, argumentsJson: '{}' }))), /未授权/);
});

test('MCP exact invoke and service query only load selected services and small matches include bounded schemas', async () => {
  const loads: Array<readonly string[] | undefined> = [];
  const connected = new Set<string>();
  const candidates = ['playwright', 'calendar'].map(server => tool({ name: `mcp_${server}__probe`, description: `${server} probe`, parameters: z.object({}), execute: async () => server }));
  const registry = new HostCapabilityRegistry([], undefined, undefined, {
    statuses: () => ['playwright', 'calendar'].map(name => ({ name, state: connected.has(name) ? 'connected' : 'configured', tools: connected.has(name) ? 1 : 0 })),
    load: async names => { loads.push(names); (names ?? ['playwright', 'calendar']).forEach(name => connected.add(name)); return candidates.filter(candidate => [...connected].some(name => candidate.name.startsWith(`mcp_${name}__`))); },
  });
  const [inspect, invoke] = gateways(registry);
  assert.equal(await invoke!.invoke(context, JSON.stringify({ name: 'mcp_playwright__probe', argumentsJson: '{}' })), 'playwright');
  assert.deepEqual(loads, [['playwright']]);
  const found = await inspect!.invoke(context, JSON.stringify({ source: 'mcp', query: 'calendar' })) as any;
  assert.deepEqual(loads, [['playwright'], ['calendar']]);
  assert.ok(found.capabilities[0].parameters);
  assert.equal(found.capabilities[0].invokeWith, 'invoke_capability');
  await inspect!.invoke(context, JSON.stringify({ source: 'mcp', query: 'playwright' }));
  assert.equal(loads.length, 2);
  assert.equal(await invoke!.invoke(context, JSON.stringify({ name: 'mcp_playwright__probe', argumentsJson: '{}' })), 'playwright');
  await invoke!.invoke(context, JSON.stringify({ name: 'mcp_missing__probe', argumentsJson: '{}' }));
  assert.equal(loads.length, 2);
});

test('targeted MCP connect leaves unrelated services cold and preserves already connected services', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-targeted-mcp-'));
  const config = path.join(root, 'mcp.json');
  const fixture = new URL('./fixtures/mcp-environment-fixture.mjs', import.meta.url).pathname;
  await writeFile(config, JSON.stringify({ mcpServers: Object.fromEntries(['one', 'two'].map(name => [name, { command: process.execPath, args: [fixture, path.join(root, name)] }])) }));
  const manager = new MCPManager(config, root);
  try {
    await manager.prepare();
    await manager.ensureConnected(['one']);
    await access(path.join(root, 'one'));
    await assert.rejects(access(path.join(root, 'two')), { code: 'ENOENT' });
    assert.equal(manager.statuses().find(status => status.name === 'two')?.state, 'configured');
    const first = manager.servers[0];
    await manager.ensureConnected(['two']);
    await access(path.join(root, 'two'));
    assert.equal(manager.servers.find(server => server.name === 'one'), first);
    assert.equal(manager.servers.length, 2);
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});

test('large schemas stay out of non-exact capability query results', async () => {
  const candidate = tool({ name: 'fixture_large', description: 'large fixture', parameters: z.object({ text: z.string().describe('x'.repeat(13_000)) }), execute: async () => 'ok' });
  const [inspect] = gateways(new HostCapabilityRegistry([candidate]));
  const found = await inspect!.invoke(context, JSON.stringify({ query: 'fixture' })) as any;
  assert.equal(found.capabilities[0].parameters, undefined);
});

test('fresh Run routes real SDK materialized names for hyphens, punctuation and truncated names', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-sdk-mcp-names-'));
  try {
    for (const [serverName, toolName] of [
      ['fixture-devices', 'read_device_metadata'],
      ['...fixture/设备📷-bridge...', 'read-device.metadata'],
      [`fixture-${'long-service-'.repeat(8)}`, 'read-device-metadata'],
      ['fixture-devices', 'read-device-metadata-'.repeat(8)],
    ]) {
      const server = { name: serverName!, cacheToolsList: false,
        listTools: async () => [{ name: toolName!, description: 'fixture', inputSchema: { type: 'object', properties: {} } }],
        callTool: async () => [{ type: 'text', text: 'fixture-ok' }],
      } as unknown as MCPServer;
      const materialize = () => materializeMcpTools({ servers: [server], ledger: new ExecutionLedger(path.join(root, 'ledger.json')), currentRun: () => undefined, model: 'fixture', reservedTools: [] });
      const [actual] = await materialize();
      assert.ok(actual);
      let loads = 0;
      const registry = new HostCapabilityRegistry([], undefined, undefined, {
        statuses: () => [{ name: serverName!, state: 'configured', tools: 0 }, { name: 'unrelated', state: 'configured', tools: 0 }],
        load: async names => { loads += 1; assert.deepEqual(names, [serverName]); return materialize(); },
      });
      const [, invoke] = gateways(registry);
      const result = await invoke!.invoke(context, JSON.stringify({ name: actual.name, argumentsJson: '{}' }));
      assert.equal(loads, 1, `direct invoke route for ${actual.name}`);
      assert.match(JSON.stringify(result), /fixture-ok/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
