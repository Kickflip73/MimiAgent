import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error Dependency-free browser module.
import { createSelectionQueue } from '../src/web/assets/pickers.js';

function fixture() {
  const calls: Array<{ key: string; value: unknown; resolve: () => void; reject: (e: Error) => void }> = [];
  const queue = createSelectionQueue((key: string, value: unknown) => new Promise<void>((resolve, reject) => calls.push({ key, value, resolve, reject })), () => {});
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  return { queue, calls, settle };
}

test('selection is immediate, rapid choices coalesce and an older response never replaces the latest choice', async () => {
  const { queue, calls, settle } = fixture();
  queue.seed('a:mode', 'general');
  queue.set('a:mode', 'plan');
  assert.equal(queue.get('a:mode').value, 'plan');
  assert.equal(queue.get('a:mode').pending, true);
  queue.set('a:mode', 'ultra');
  queue.set('a:mode', 'general');
  assert.equal(calls.length, 1);
  calls[0]!.resolve(); await settle();
  assert.equal(queue.get('a:mode').value, 'general');
  assert.equal(calls[1]!.value, 'general');
  calls[1]!.resolve(); await settle();
  assert.equal(queue.get('a:mode').pending, false);
  queue.set('a:mode', 'general');
  assert.equal(calls.length, 2);
});

test('failure restores confirmed choice, exposes an error and allows retry without affecting another session', async () => {
  const { queue, calls, settle } = fixture();
  queue.seed('a:model', null); queue.seed('b:mode', 'general');
  queue.set('a:model', { modelId: 'test', providerId: 'test' });
  queue.set('b:mode', 'plan');
  calls[0]!.reject(new Error('unavailable')); await settle();
  assert.equal(queue.get('a:model').value, null);
  assert.equal(queue.get('a:model').error, 'unavailable');
  assert.equal(queue.get('b:mode').pending, true);
  queue.set('a:model', { modelId: 'test', providerId: 'test' });
  calls[2]!.resolve(); calls[1]!.resolve(); await settle();
  assert.equal(queue.get('a:model').error, '');
  assert.equal(queue.get('b:mode').value, 'plan');
});

test('a failed superseded request still writes the latest selection, and stale reads cannot overwrite it', async () => {
  const { queue, calls, settle } = fixture();
  queue.seed('a:mode', 'general');
  const revision = queue.version('a:mode');
  queue.set('a:mode', 'plan'); queue.set('a:mode', 'ultra');
  queue.seed('a:mode', 'general', revision);
  assert.equal(queue.get('a:mode').value, 'ultra');
  calls[0]!.reject(new Error('old failure')); await settle();
  assert.equal(calls[1]!.value, 'ultra');
  calls[1]!.resolve(); await settle();
  queue.seed('a:mode', 'general', revision);
  assert.equal(queue.get('a:mode').value, 'ultra');
  assert.equal(queue.get('a:mode').error, '');
});
