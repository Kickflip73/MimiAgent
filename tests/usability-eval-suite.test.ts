import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

interface UsabilityCase {
  name: string;
  input: string;
  expectedTools?: string[];
  expectedAnyTools?: string[][];
  expectedOutputPatterns?: string[];
  forbiddenTools?: string[];
  fixtureFiles?: Record<string, string>;
  expectedFiles?: Array<{ path: string }>;
  maxDurationMs?: number;
  env?: Record<string, string>;
}

test('phase-one usability eval keeps twenty isolated, bounded daily journeys', async () => {
  const file = path.join(process.cwd(), 'evals', 'usability-cases.json');
  const cases = JSON.parse(await readFile(file, 'utf8')) as UsabilityCase[];

  assert.equal(cases.length, 20);
  assert.equal(new Set(cases.map((item) => item.name)).size, cases.length);
  assert.ok(cases.some((item) => (item.expectedTools ?? []).includes('read_file')));
  assert.ok(cases.some((item) => (item.expectedTools ?? []).includes('run_shell')));
  const webResearch = cases.find(item => item.name === '08 查询实时网页信息');
  assert.ok(webResearch);
  assert.ok(webResearch.expectedAnyTools?.some(group => group.includes('web_search') && group.includes('invoke_capability')));
  assert.ok(webResearch.expectedOutputPatterns?.includes('nodejs\\.org'));
  assert.ok(cases.some((item) => (item.expectedTools ?? []).includes('inspect_capabilities')));
  assert.ok(cases.some((item) => item.env?.MIMI_MODE === 'plan'));

  for (const item of cases) {
    assert.ok(item.name.trim());
    assert.ok(item.input.trim());
    assert.ok((item.maxDurationMs ?? 0) >= 30_000);
    for (const requestedPath of [
      ...Object.keys(item.fixtureFiles ?? {}),
      ...(item.expectedFiles ?? []).map((expectation) => expectation.path),
    ]) {
      assert.equal(path.isAbsolute(requestedPath), false);
      assert.equal(path.normalize(requestedPath).startsWith('..'), false);
    }
  }
});
