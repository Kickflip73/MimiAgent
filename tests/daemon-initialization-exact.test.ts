import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../src/config.js';
import { initializeMimi } from '../src/daemon/service.js';

const CONNECTORS_CONFIG_ENV = 'MIMI_CONNECTORS_CONFIG';
const CONNECTORS_CONFIG_MODE_ENV = 'MIMI_CONNECTORS_CONFIG_MODE';

function appConfig(root: string): AppConfig {
  return {
    provider: 'openai',
    workspaceRoot: process.cwd(),
    dataRoot: path.join(root, 'data'),
    daemonDataRoot: path.join(root, 'daemon'),
    skillsRoot: path.join(root, 'skills'),
    mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40,
    maxTurns: 200,
  };
}

async function withConnectorEnvironment<T>(
  values: Readonly<Record<string, string | undefined>>,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('exact connector initialization is strict, immutable, and fail-closed', async (t) => {
  await t.test('keeps an empty Darwin config byte-identical without reading the template', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-connectors-exact-'));
    const connectorsFile = path.join(root, 'exact-connectors.json');
    const raw = '{\n  "connectors": {}\n}\n';
    try {
      await writeFile(connectorsFile, raw);
      await chmod(connectorsFile, 0o644);
      const before = createHash('sha256').update(await readFile(connectorsFile)).digest('hex');

      const result = await withConnectorEnvironment({
        [CONNECTORS_CONFIG_ENV]: connectorsFile,
        [CONNECTORS_CONFIG_MODE_ENV]: 'exact',
      }, () => initializeMimi(appConfig(root), {
        platform: 'darwin',
        runtimeRoot: path.join(root, 'missing-runtime-root'),
      }));

      const afterBytes = await readFile(connectorsFile);
      assert.equal(afterBytes.toString('utf8'), raw);
      assert.equal(createHash('sha256').update(afterBytes).digest('hex'), before);
      assert.equal((await stat(connectorsFile)).mode & 0o777, 0o600);
      assert.deepEqual(result.connectors, {
        file: connectorsFile,
        created: false,
        updatedActions: 0,
        removedRetired: 0,
        total: 0,
        enabled: [],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test('rejects exact mode when the configured file is missing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-connectors-exact-missing-'));
    try {
      await assert.rejects(
        withConnectorEnvironment({
          [CONNECTORS_CONFIG_ENV]: path.join(root, 'missing-connectors.json'),
          [CONNECTORS_CONFIG_MODE_ENV]: 'exact',
        }, () => initializeMimi(appConfig(root), { runtimeRoot: process.cwd() })),
        /MIMI_CONNECTORS_CONFIG.*exact.*不存在/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test('rejects unknown connector config modes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-connectors-mode-'));
    try {
      await assert.rejects(
        withConnectorEnvironment({
          [CONNECTORS_CONFIG_MODE_ENV]: 'append',
        }, () => initializeMimi(appConfig(root), { runtimeRoot: process.cwd() })),
        /MIMI_CONNECTORS_CONFIG_MODE.*exact/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test('strictly rejects unknown exact config fields without rewriting the file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-connectors-exact-invalid-'));
    const connectorsFile = path.join(root, 'invalid-connectors.json');
    const raw = '{"connectors":{},"unknown":true}\n';
    try {
      await writeFile(connectorsFile, raw);
      await assert.rejects(withConnectorEnvironment({
        [CONNECTORS_CONFIG_ENV]: connectorsFile,
        [CONNECTORS_CONFIG_MODE_ENV]: 'exact',
      }, () => initializeMimi(appConfig(root), { runtimeRoot: process.cwd() })));
      assert.equal(await readFile(connectorsFile, 'utf8'), raw);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
