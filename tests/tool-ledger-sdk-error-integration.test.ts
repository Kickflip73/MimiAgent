import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext } from '@openai/agents';
import { ExecutionLedger } from '../src/core/execution-ledger.js';
import { withExecutionLedger } from '../src/runtime/tool-ledger.js';
import { createTools } from '../src/tools.js';

test('a production SDK tool failure is visible to the model but never committed as succeeded', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-tool-ledger-sdk-error-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  const write = createTools(root, false, [], {
    writablePaths: ['allowed'],
    allowShell: false,
    postWriteDiagnostics: false,
  }).find((candidate) => candidate.name === 'write_file');
  assert.ok(write);
  const [wrapped] = withExecutionLedger([write], ledger, () => ({
    sessionId: 'owner',
    runId: 'run-write-failure',
  }));
  assert.ok(wrapped && 'invoke' in wrapped);

  const result = await wrapped.invoke(
    new RunContext({}),
    JSON.stringify({ path: 'blocked.txt', content: 'must-not-exist' }),
    { toolCall: { callId: 'write-call' } } as never,
  ) as Record<string, unknown>;

  assert.equal(result.mimiStatus, 'tool_failed');
  assert.equal(result.retryable, false);
  assert.match(String(result.message), /超出当前声明|不在允许写入范围|拒绝/);
  const [call] = await ledger.listCalls('owner', 'run-write-failure');
  assert.equal(call?.status, 'failed');
});
