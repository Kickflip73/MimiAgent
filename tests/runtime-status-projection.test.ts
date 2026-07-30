import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunContext } from '@openai/agents';
import { createRuntimeControlTools } from '../src/runtime/control.js';

function controls(seen: string[]) {
  return {
    status: (projection: 'summary' | 'detail') => {
      seen.push(projection);
      return projection === 'summary'
        ? {
            schemaVersion: 1,
            projection,
            model: 'model-a',
            mode: 'general',
            capability: {
              toolSetDigest: 'sha256:one',
              tools: ['read_file', 'runtime_status'],
            },
          }
        : {
            schemaVersion: 1,
            projection,
            guidanceFiles: Array.from({ length: 100 }, (_, index) => ({ path: `file-${index}` })),
          };
    },
    models: () => [],
    providers: () => [],
    modes: () => [],
    listSessions: () => [],
    history: async () => [],
    schedule: () => undefined,
  };
}

async function invokeStatus(input: Record<string, unknown>, seen: string[]): Promise<unknown> {
  const runtimeStatus = createRuntimeControlTools(controls(seen))
    .find((candidate) => candidate.name === 'runtime_status');
  assert.ok(runtimeStatus && 'invoke' in runtimeStatus);
  return runtimeStatus.invoke(new RunContext({}), JSON.stringify(input));
}

test('runtime_status defaults to the bounded summary projection', async () => {
  const seen: string[] = [];
  const result = await invokeStatus({}, seen);
  assert.deepEqual(seen, ['summary']);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 12 * 1024);
  assert.deepEqual(
    (result as { capability: { tools: string[] } }).capability.tools,
    ['read_file', 'runtime_status'],
  );
});

test('runtime_status loads diagnostic detail only through an explicit structured field', async () => {
  const seen: string[] = [];
  const result = await invokeStatus({ projection: 'detail' }, seen);
  assert.deepEqual(seen, ['detail']);
  assert.equal((result as { projection: string }).projection, 'detail');
  assert.ok(JSON.stringify(result).includes('guidanceFiles'));
});
