import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext, type Tool } from '@openai/agents';
import { PreferenceStore } from '../src/core/preferences.js';
import {
  createMimiPreferenceTools,
  withoutMimiPreferenceTools,
} from '../src/runtime/preference-tools.js';

test('exposes owner preference management and strips it from non-owner runs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-preference-tools-'));
  const store = new PreferenceStore(path.join(root, 'PREFERENCES.md'));
  const tools = createMimiPreferenceTools(store);
  const invoke = async (name: string, input: object) => {
    const selected = tools.find((item) => item.name === name);
    assert.ok(selected && 'invoke' in selected);
    return selected.invoke(new RunContext({}), JSON.stringify(input));
  };

  assert.deepEqual(tools.map((tool) => tool.name), [
    'list_mimi_preferences',
    'add_mimi_preference',
    'remove_mimi_preference',
  ]);
  await invoke('add_mimi_preference', { instruction: 'Prefer dedicated tools.' });
  assert.deepEqual(await invoke('list_mimi_preferences', {}), {
    file: store.file,
    preferences: ['Prefer dedicated tools.'],
  });
  assert.equal(
    (await invoke('remove_mimi_preference', { instruction: 'Prefer dedicated tools.' }) as { changed: boolean }).changed,
    true,
  );
  assert.deepEqual(
    withoutMimiPreferenceTools([
      ...tools,
      { name: 'read_file' } as Tool,
    ]).map((tool) => tool.name),
    ['read_file'],
  );
});
