import assert from 'node:assert/strict';
import test from 'node:test';
import { RunContext } from '@openai/agents';
import { modelControlRequestSchema } from '../src/core/model-routing.js';
import { createModelControlTools } from '../src/runtime/model-control-tools.js';

test('model control request schema keeps route target and auto mutually exclusive', () => {
  assert.deepEqual(modelControlRequestSchema.parse({
    action: 'route',
    scenario: 'team.hard',
    target: { providerId: 'right', modelId: 'right-model' },
  }), {
    action: 'route',
    scenario: 'team.hard',
    target: { providerId: 'right', modelId: 'right-model' },
  });
  assert.throws(() => modelControlRequestSchema.parse({
    action: 'route',
    scenario: 'team.hard',
    target: { providerId: 'right', modelId: 'right-model' },
    routeAuto: true,
  }));
});

test('model control permits read actions and requires direct Owner for writes', async () => {
  let owner = false;
  const writes: string[] = [];
  const tools = createModelControlTools({
    list: () => [{ target: { providerId: 'fake', modelId: 'text' } }],
    inspect: (target) => target,
    current: () => ({ routeVersion: 1 }),
    setSession: (target) => {
      writes.push(`use:${target.providerId}/${target.modelId}`);
      return { effective: 'next_run' };
    },
    clearSession: () => {
      writes.push('auto');
      return { effective: 'next_run' };
    },
    routes: () => ({ routeVersion: 1 }),
    setRoute: (scenario) => {
      writes.push(`route:${scenario}`);
      return { routeVersion: 2 };
    },
    doctor: () => ({ status: 'healthy' }),
    assertOwner: () => {
      if (!owner) throw new Error('direct Owner required');
    },
  });
  const control = tools.find((item) => item.name === 'model_control');
  if (!control || !('invoke' in control)) {
    throw new Error('model control tools are not callable');
  }
  assert.match(JSON.stringify(await control.invoke(
    new RunContext({}),
    JSON.stringify({ action: 'list' }),
  )), /fake/);
  assert.match(String(await control.invoke(
    new RunContext({}),
    JSON.stringify({
      action: 'use',
      target: { providerId: 'fake', modelId: 'text' },
    }),
  )), /direct Owner/);
  owner = true;
  assert.match(JSON.stringify(await control.invoke(
    new RunContext({}),
    JSON.stringify({
      action: 'use',
      target: { providerId: 'fake', modelId: 'text' },
    }),
  )), /next_run/);
  assert.deepEqual(writes, ['use:fake/text']);
});
