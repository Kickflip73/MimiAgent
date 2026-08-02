import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const budgets = {
  'src/runtime/mimi-agent.ts': 1_800,
  'src/daemon/service.ts': 1_800,
  'src/daemon/store.ts': 1_900,
} as const;

test('M1 composition roots stay within their source-line budgets', async () => {
  for (const [file, maximum] of Object.entries(budgets)) {
    const source = await readFile(path.resolve(file), 'utf8');
    const lines = source.endsWith('\n') ? source.split('\n').length - 1 : source.split('\n').length;
    assert.ok(lines <= maximum, `${file}: ${lines} > ${maximum}`);
  }
});
