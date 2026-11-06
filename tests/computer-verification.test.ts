import assert from 'node:assert/strict';
import test from 'node:test';
import { launchedWindowRefs, verifyE2EObservation } from '../scripts/lib/computer-e2e-oracle.js';
import { verifyComputerState } from '../src/extensions/computer/verification.js';

const target = { bundleId: 'test', pid: 10, windowId: 20, appName: 'test', title: '56', bounds: { x: 0, y: 0, width: 100, height: 100 } };
test('oracle window ownership comes only from a paired successful launch tool receipt', () => {
  const items = [
    { type: 'function_call', name: 'computer_act', callId: 'launch', arguments: '{"action":{"type":"launch_app"}}' },
    { type: 'function_call_result', callId: 'unrelated', output: { ok: true, state: { targetRef: 'other:1:2' } } },
    { type: 'message', output: { ok: true, state: { targetRef: 'claimed:1:2' } } },
    { type: 'function_call_result', callId: 'launch', output: { ok: true, state: { targetRef: 'test:10:20' } } },
  ];
  assert.deepEqual([...launchedWindowRefs(items)], ['test:10:20']);
});
test('E2E oracle rejects echoed answers, wrong windows, buttons, prefixes and ambiguous values', () => {
  assert.equal(verifyE2EObservation({ target, data: { prompt: '56', output: '56' } }, target, 'AXStaticText', '56'), false);
  for (const observation of [
    { target: { ...target, windowId: 21 }, elements: [{ index: 1, role: 'AXStaticText', value: '56' }] },
    { target, elements: [{ index: 1, role: 'AXButton', value: '56' }] },
    { target, elements: [{ index: 1, role: 'AXStaticText', value: '156' }] },
    { target, elements: [1, 2].map(index => ({ index, role: 'AXStaticText', value: '56' })) },
  ]) assert.equal(verifyE2EObservation(observation, target, 'AXStaticText', '56'), false);
  assert.equal(verifyE2EObservation({ target, elements: [{ index: 1, role: 'AXStaticText', value: '56' }] }, target, 'AXStaticText', '56'), true);
});

test('verification requires a fresh unique semantic value and distinguishes failure from unavailability', () => {
  const state = { observationId: 'fresh', actionable: true, elements: [{ index: 1, role: 'AXTextArea', value: 'actual' }] };
  assert.equal(verifyComputerState(state).status, 'not_requested');
  assert.equal(verifyComputerState(state, { role: 'AXTextArea', equals: 'actual' }).status, 'passed');
  assert.equal(verifyComputerState(state, { role: 'AXTextArea', equals: 'expected' }).status, 'failed');
  assert.equal(verifyComputerState({ ...state, truncated: true }, { role: 'AXTextArea', equals: 'actual' }).status, 'unavailable');
  assert.equal(verifyComputerState({ ...state, elements: [...state.elements, ...state.elements] }, { role: 'AXTextArea', equals: 'actual' }).status, 'unavailable');
});
