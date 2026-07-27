import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../src/config.js';
import { initializeMimi } from '../src/daemon/service.js';

test('initialization removes retired IM and HTTP connectors from existing configurations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-retired-connectors-'));
  const daemonDataRoot = path.join(root, 'daemon');
  const config: AppConfig = {
    provider: 'openai',
    workspaceRoot: process.cwd(),
    dataRoot: path.join(root, 'data'),
    daemonDataRoot,
    skillsRoot: path.join(root, 'skills'),
    mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40,
    maxTurns: 200,
  };

  try {
    const template = JSON.parse(
      await readFile(path.join(process.cwd(), 'mimi.connectors.example.json'), 'utf8'),
    ) as { connectors: Record<string, Record<string, unknown>> };
    const retained = template.connectors['openclaw-weixin'];
    assert.ok(retained);
    await mkdir(daemonDataRoot, { recursive: true });
    await writeFile(path.join(daemonDataRoot, 'connectors.json'), `${JSON.stringify({
      connectors: {
        'openclaw-weixin': retained,
        daxiang: { ...retained, args: ['/tmp/daxiang-connector.mjs'] },
        qq: { ...retained, args: ['/tmp/custom-qq-bridge.mjs'] },
        'legacy-wechat': { ...retained, args: ['/tmp/wechat-applescript-connector.mjs'] },
        'http-action': { ...retained, args: ['/tmp/http-action-connector.mjs'] },
      },
    })}\n`);

    const result = await initializeMimi(config, { runtimeRoot: process.cwd() });
    const persisted = JSON.parse(
      await readFile(path.join(daemonDataRoot, 'connectors.json'), 'utf8'),
    ) as { connectors: Record<string, unknown> };

    assert.equal(result.connectors.removedRetired, 4);
    assert.deepEqual(Object.keys(persisted.connectors).sort(), ['macos-system', 'openclaw-weixin']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
