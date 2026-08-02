import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Tool } from '@openai/agents';
import { AgentRequestFactory } from '../src/runtime/pipeline/request-factory.js';
import { HostCapabilityRegistry } from '../src/runtime/pipeline/capability-registry.js';
import { ToolSetBuilder } from '../src/runtime/pipeline/tool-set-builder.js';

const tool = (name: string): Tool => ({ name }) as Tool;

for (const scenario of [
  {
    name: 'general workstation',
    mode: 'general' as const,
    permissionMode: 'workspace' as const,
    securityProfile: 'workstation' as const,
  },
  {
    name: 'plan full owner',
    mode: 'plan' as const,
    permissionMode: 'trusted' as const,
    securityProfile: 'full-owner' as const,
  },
]) {
  test(`status snapshot equals the actual model Tool surface for ${scenario.name}`, () => {
    const builder = new ToolSetBuilder();
    const actualTools = builder.final(
      scenario.mode,
      [
        tool('read_file'),
        tool('write_file'),
        tool('run_shell'),
        tool('runtime_status'),
        tool('update_plan'),
      ],
      [],
      [],
      scenario.permissionMode,
      scenario.securityProfile,
    );
    const snapshot = new HostCapabilityRegistry(actualTools).snapshot({
      runId: `run-${scenario.name}`,
      policyRevision: scenario.name,
      modelTools: actualTools,
      observedAt: '2026-07-30T00:00:00.000Z',
    });
    const request = new AgentRequestFactory().create({
      model: 'gpt-test',
      instructions: 'system',
      tools: actualTools,
      outputReserve: 1_000,
    });

    assert.deepEqual(snapshot.tools, [...request.toolNames].sort());
    assert.equal(snapshot.hiddenToolCount, 0);
    assert.deepEqual(snapshot.hiddenTools, []);
    assert.deepEqual(
      snapshot.items
        .filter((item) => item.kind === 'tool' && item.availability === 'available')
        .map((item) => item.id),
      snapshot.tools,
    );
  });
}
