import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentInputItem } from '@openai/agents';
import {
  assertNoRepeatedToolCycle,
  detectRepeatedToolCycle,
  RunNoProgressCycleError,
} from '../src/runtime/tool-cycle-guard.js';

function call(
  callId: string,
  name: string,
  argumentsValue: Record<string, unknown>,
  output: unknown,
): AgentInputItem[] {
  return [
    { type: 'function_call', callId, name, arguments: JSON.stringify(argumentsValue) },
    { type: 'function_call_result', callId, name, status: 'completed', output },
  ] as AgentInputItem[];
}

test('detects the alternating A/B no-progress cycle from the current user turn', () => {
  const input = [
    { role: 'user', content: '读取两个 issue' },
    ...call('a-1', 'run_shell', { command: 'issue get HXST-238' }, { stdout: '238 description' }),
    ...call('b-1', 'run_shell', { command: 'issue get HXST-237' }, { stdout: '237 description' }),
    ...call('a-2', 'run_shell', { command: 'issue get HXST-238' }, { stdout: '238 description' }),
    ...call('b-2', 'run_shell', { command: 'issue get HXST-237' }, { stdout: '237 description' }),
    ...call('a-3', 'run_shell', { command: 'issue get HXST-238' }, { stdout: '238 description' }),
    ...call('b-3', 'run_shell', { command: 'issue get HXST-237' }, { stdout: '237 description' }),
  ] as AgentInputItem[];

  assert.deepEqual(detectRepeatedToolCycle(input), {
    period: 2,
    repetitions: 3,
    toolNames: ['run_shell', 'run_shell'],
  });
  assert.throws(() => assertNoRepeatedToolCycle(input), RunNoProgressCycleError);
});

test('does not stop polling when the observed result changes', () => {
  const input = [
    { role: 'user', content: '等待部署完成' },
    ...call('poll-1', 'deployment_status', { id: 'deploy-1' }, { state: 'queued' }),
    ...call('poll-2', 'deployment_status', { id: 'deploy-1' }, { state: 'running' }),
    ...call('poll-3', 'deployment_status', { id: 'deploy-1' }, { state: 'completed' }),
  ] as AgentInputItem[];

  assert.equal(detectRepeatedToolCycle(input), undefined);
});

test('does not combine matching calls from different user turns', () => {
  const input = [
    { role: 'user', content: '第一次读取' },
    ...call('old-1', 'read_file', { path: 'a.ts' }, 'same'),
    ...call('old-2', 'read_file', { path: 'a.ts' }, 'same'),
    { role: 'assistant', content: '第一次完成' },
    { role: 'user', content: '重新读取' },
    ...call('new-1', 'read_file', { path: 'a.ts' }, 'same'),
  ] as AgentInputItem[];

  assert.equal(detectRepeatedToolCycle(input), undefined);
});

test('normalizes JSON argument key order before comparing calls', () => {
  const input = [
    { role: 'user', content: '读取' },
    ...call('one', 'query', { issue: 'HXST-238', format: 'json' }, 'same'),
    {
      type: 'function_call', callId: 'two', name: 'query',
      arguments: '{"format":"json","issue":"HXST-238"}',
    },
    { type: 'function_call_result', callId: 'two', name: 'query', output: 'same' },
    ...call('three', 'query', { issue: 'HXST-238', format: 'json' }, 'same'),
  ] as AgentInputItem[];

  assert.equal(detectRepeatedToolCycle(input)?.period, 1);
});
