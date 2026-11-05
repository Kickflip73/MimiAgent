import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

async function browserUuid(crypto: object): Promise<() => string> {
  const source = await readFile(new URL('../src/web/assets/uuid.js', import.meta.url), 'utf8');
  return runInNewContext(`${source.replace('export function', 'function')}\nrandomUUID;`, { crypto });
}

test('HTTP browser UUID generation works without secure-context randomUUID', async () => {
  const uuid = await browserUuid({ getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
  const values = Array.from({ length: 100 }, () => uuid());
  assert.equal(new Set(values).size, values.length);
  for (const value of values) assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('UUID preserves random bytes while setting version and variant bits', async () => {
  let calls = 0;
  const uuid = await browserUuid({ getRandomValues: (bytes: Uint8Array) => {
    calls++;
    assert.equal(bytes.length, 16);
    return bytes.fill(255);
  } });
  assert.equal(uuid(), 'ffffffff-ffff-4fff-bfff-ffffffffffff');
  assert.equal(calls, 1);
});
