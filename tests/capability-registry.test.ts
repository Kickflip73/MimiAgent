import assert from 'node:assert/strict';
import test from 'node:test';
import { RunContext, tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import { ContextManager } from '../src/core/context.js';
import { HostCapabilityRegistry } from '../src/runtime/pipeline/capability-registry.js';
import { AgentRequestFactory } from '../src/runtime/pipeline/request-factory.js';
import { ToolSetBuilder } from '../src/runtime/pipeline/tool-set-builder.js';

type InvokableTool = Tool & {
  invoke(context: RunContext<unknown>, input: string, details: unknown): Promise<unknown>;
};

function invoker(tools: readonly Tool[], name: string): InvokableTool {
  const selected = tools.find((candidate) => candidate.name === name) as InvokableTool | undefined;
  assert.ok(selected?.invoke);
  return selected;
}

function connectorActionTool(): Tool {
  return tool({
    name: 'connector_capability',
    description: 'Invoke one catalogued Connector action.',
    parameters: z.object({
      capability: z.string(),
      action: z.string(),
      target: z.string(),
      payloadJson: z.string(),
    }),
    execute: async ({ action }) => `${action}-ok`,
  });
}

test('registry reads Connector catalog directly, caches by Run revision, and excludes legacy tools', async () => {
  let revision = 'ready:v1';
  let catalogReads = 0;
  const catalogFilters: Array<{ connector?: string; capability?: string; query?: string }> = [];
  let legacyToolCalls = 0;
  const legacyInspector = tool({
    name: 'inspect_mimi_capabilities',
    description: 'legacy compatibility surface',
    parameters: z.object({ query: z.string().optional() }),
    execute: async () => {
      legacyToolCalls += 1;
      throw new Error('runtime must not call a Tool from another Tool');
    },
  });
  const registry = new HostCapabilityRegistry(
    [legacyInspector, connectorActionTool()],
    {
      revision: () => revision,
      inspectConnector: async (filter) => {
        catalogReads += 1;
        catalogFilters.push(filter);
        return {
          filterMatched: true,
          actions: 1,
          connectors: [{
            id: 'mail',
            actions: [{ name: 'send', capability: 'mail.send', effect: 'write' }],
          }],
        };
      },
    },
  );
  assert.deepEqual(registry.authorizedTools().map((candidate) => candidate.name), ['connector_capability']);
  const gateway = registry.gatewayTools(registry.authorizedTools());
  const inspect = invoker(gateway, 'inspect_capabilities');
  const invoke = invoker(gateway, 'invoke_capability');
  const context = new RunContext({});
  const query = JSON.stringify({ source: 'connector', query: 'mail send' });

  const first = await inspect.invoke(context, query, {});
  assert.deepEqual(await inspect.invoke(context, query, {}), first);
  assert.deepEqual(await inspect.invoke(context, query, {}), first);
  assert.equal(catalogReads, 1);
  assert.equal(legacyToolCalls, 0);
  assert.equal(
    await invoke.invoke(context, JSON.stringify({
      name: 'connector_capability',
      argumentsJson: JSON.stringify({
        capability: 'mail.send', action: 'send', target: 'owner', payloadJson: '{}',
      }),
    }), {}),
    'send-ok',
  );

  revision = 'unavailable:v2';
  assert.match(String(await invoke.invoke(context, JSON.stringify({
    name: 'connector_capability',
    argumentsJson: JSON.stringify({
      capability: 'mail.send', action: 'send', target: 'owner', payloadJson: '{}',
    }),
  }), {})), /尚未通过.*精确发现/);
  await inspect.invoke(context, query, {});
  assert.equal(catalogReads, 2);
  assert.equal(legacyToolCalls, 0);

  const exact = await inspect.invoke(context, JSON.stringify({
    source: 'connector', capability: 'mail.send',
  }), {}) as { matchedCount: number };
  assert.match(JSON.stringify(exact), /mail\.send/);
  assert.equal(exact.matchedCount, 1);
  assert.equal(catalogReads, 3);
  assert.deepEqual(catalogFilters.at(-1), { capability: 'mail.send' });
  assert.deepEqual(
    await inspect.invoke(context, JSON.stringify({
      source: 'connector', name: 'mail.send',
    }), {}),
    exact,
  );
  assert.equal(catalogReads, 3);
});

test('registry rejects duplicate authority and snapshot equals the SDK model surface', async () => {
  const duplicate = () => tool({
    name: 'duplicate_tool',
    description: 'duplicate',
    parameters: z.object({}),
    execute: async () => 'ok',
  });
  assert.throws(
    () => new HostCapabilityRegistry([duplicate(), duplicate()]),
    /重复 Tool.*duplicate_tool/,
  );

  const registry = new HostCapabilityRegistry([
    tool({
      name: 'read_file',
      description: 'read',
      parameters: z.object({ path: z.string() }),
      execute: async () => 'ok',
    }),
    tool({
      name: 'deferred_extension',
      description: 'deferred',
      parameters: z.object({}),
      execute: async () => 'ok',
    }),
  ]);
  const builder = new ToolSetBuilder();
  const classified = builder.classify([...registry.authorizedTools()]);
  const selected = builder.sdkTools(classified, registry.gatewayTools(classified.deferred));
  const request = new AgentRequestFactory().create({
    model: 'gpt-test',
    instructions: 'system',
    tools: selected,
    outputReserve: 1_000,
  });
  const actual = await request.agent.getAllTools(new RunContext({}));
  const snapshot = registry.snapshot({
    runId: 'exact-sdk-surface',
    policyRevision: 'test:v1',
    modelTools: actual,
    observedAt: '2026-08-02T00:00:00.000Z',
  });
  assert.deepEqual(snapshot.tools, actual.map((candidate) => candidate.name).sort());
  assert.deepEqual(snapshot.hiddenTools.flatMap((group) => group.names), ['deferred_extension']);
});

test('an empty deferred surface does not advertise discovery gateway tools', () => {
  const registry = new HostCapabilityRegistry([]);
  assert.deepEqual(registry.gatewayTools([]), []);
});

test('50 Host tools, 50 MCP tools, and 50 Connector actions keep first-round schemas bounded', async () => {
  const makeDeferred = (name: string) => tool({
    name,
    description: `${name} ${'bounded metadata '.repeat(20)}`,
    parameters: z.object({ value: z.string().describe('bounded value') }),
    execute: async () => 'ok',
  });
  const hostTools = Array.from({ length: 50 }, (_, index) => makeDeferred(`extension_${index}`));
  const mcpTools = Array.from({ length: 50 }, (_, index) => makeDeferred(`mcp_fixture__action_${index}`));
  const actions = Array.from({ length: 50 }, (_, index) => ({
    name: `action_${index}`,
    capability: `fixture.action-${index}`,
    effect: 'read',
    description: `Connector action ${index}`,
  }));
  const registry = new HostCapabilityRegistry(
    [...hostTools, ...mcpTools, connectorActionTool()],
    {
      revision: () => 'catalog:v1',
      inspectConnector: async () => ({
        filterMatched: true,
        actions: actions.length,
        connectors: [{ id: 'fixture', actions }],
      }),
    },
  );
  const builder = new ToolSetBuilder();
  const classified = builder.classify([...registry.authorizedTools()]);
  const gateway = registry.gatewayTools(classified.deferred);
  const modelTools = builder.sdkTools(classified, gateway);
  const request = new AgentRequestFactory().create({
    model: 'gpt-test',
    instructions: 'system',
    tools: modelTools,
    outputReserve: 8_000,
  });
  const actual = await request.agent.getAllTools(new RunContext({}));
  assert.deepEqual(actual.map((candidate) => candidate.name), [
    'inspect_capabilities',
    'invoke_capability',
  ]);
  const serialized = actual.map((candidate) => {
    const value = candidate as unknown as Record<string, unknown>;
    return { name: value.name, description: value.description, parameters: value.parameters };
  });
  assert.ok(new ContextManager().requestBudget(serialized).toolSchemaTokens <= 4_000);

  const catalog = await invoker(gateway, 'inspect_capabilities').invoke(
    new RunContext({}),
    JSON.stringify({ source: 'connector', query: 'fixture' }),
    {},
  ) as { connectorCatalog: { actions: number } };
  assert.equal(catalog.connectorCatalog.actions, 50);
});
