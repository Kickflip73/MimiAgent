import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../src/config.js';
import { initializeMimi } from '../src/daemon/service.js';

test('initialization removes every retired WeChat, IM, and HTTP connector', async () => {
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
    const retained = template.connectors.radar;
    assert.ok(retained);
    await mkdir(daemonDataRoot, { recursive: true });
    await writeFile(path.join(daemonDataRoot, 'connectors.json'), `${JSON.stringify({
      connectors: {
        'openclaw-weixin': retained,
        'personal-wechat': { ...retained, args: ['/tmp/personal-message-connector.mjs', '--channel=wechat'] },
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

    assert.equal(result.connectors.removedRetired, 6);
    assert.deepEqual(Object.keys(persisted.connectors).sort(), [
      'macos-desktop',
      'macos-system',
      'personal-daxiang',
      'personal-qq',
    ]);
    for (const id of ['personal-daxiang', 'personal-qq']) {
      assert.equal((persisted.connectors[id] as { enabled: boolean }).enabled, false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('initialization syncs action metadata for an identical managed connector copy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-managed-connector-copy-'));
  const daemonDataRoot = path.join(root, 'daemon');
  const copiedScript = path.join(root, 'checkout', 'examples', 'connectors', 'macos-shortcuts-connector.mjs');
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
    ) as { backgroundDefaultsVersion?: number; connectors: Record<string, Record<string, unknown>> };
    const packaged = template.connectors['macos-shortcuts'] as {
      actions: Record<string, Record<string, unknown>>;
    };
    assert.ok(packaged);
    await mkdir(path.dirname(copiedScript), { recursive: true });
    await writeFile(
      copiedScript,
      await readFile(path.join(process.cwd(), 'examples/connectors/macos-shortcuts-connector.mjs')),
    );
    await mkdir(daemonDataRoot, { recursive: true });
    await writeFile(path.join(daemonDataRoot, 'connectors.json'), `${JSON.stringify({
      backgroundDefaultsVersion: template.backgroundDefaultsVersion,
      connectors: {
        'macos-shortcuts': {
          ...packaged,
          enabled: false,
          command: process.execPath,
          args: [copiedScript],
          syncTemplateActions: true,
          actions: Object.fromEntries(Object.entries(packaged.actions).map(([name, action]) => [
            name,
            {
              ...action,
              description: `stale ${name}`,
              capability: undefined,
              effect: 'unknown',
              modelVisible: false,
            },
          ])),
        },
      },
    })}\n`);

    const result = await initializeMimi(config, { runtimeRoot: process.cwd() });
    const persisted = JSON.parse(
      await readFile(path.join(daemonDataRoot, 'connectors.json'), 'utf8'),
    ) as {
      connectors: Record<string, {
        args: string[];
        actions: Record<string, { capability?: string; effect: string; modelVisible?: boolean }>;
      }>;
    };
    const migrated = persisted.connectors['macos-shortcuts'];
    assert.ok(migrated);
    assert.equal(result.connectors.updatedActions, 3);
    assert.deepEqual(migrated.args, [copiedScript]);
    assert.equal(migrated.actions.list_folders?.capability, 'shortcuts.catalog.read');
    assert.equal(migrated.actions.list_folders?.effect, 'read');
    assert.equal(migrated.actions.list_folders?.modelVisible, true);
    assert.equal(
      (migrated.actions.list_folders as { description?: string }).description,
      (packaged.actions.list_folders as { description?: string }).description,
    );
    assert.equal(migrated.actions.run_shortcut?.capability, 'shortcuts.run');
    assert.equal(migrated.actions.run_shortcut?.effect, 'write');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('initialization replaces enabled macos-browser with the unified Browser Connector', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-browser-migration-'));
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
    ) as { backgroundDefaultsVersion?: number; connectors: Record<string, Record<string, unknown>> };
    const legacy = {
      ...template.connectors.browser,
      enabled: true,
      args: ['/tmp/macos-browser-connector.mjs'],
      claimedComputerApps: ['com.apple.Safari', 'com.google.Chrome'],
    };
    await mkdir(daemonDataRoot, { recursive: true });
    await writeFile(path.join(daemonDataRoot, 'connectors.json'), `${JSON.stringify({
      backgroundDefaultsVersion: template.backgroundDefaultsVersion,
      connectors: { 'macos-browser': legacy },
    })}\n`);

    const result = await initializeMimi(config, { runtimeRoot: process.cwd() });
    const persisted = JSON.parse(
      await readFile(path.join(daemonDataRoot, 'connectors.json'), 'utf8'),
    ) as {
      connectors: Record<string, {
        enabled: boolean;
        args: string[];
        claimedComputerApps: string[];
      }>;
    };

    assert.equal(persisted.connectors['macos-browser'], undefined);
    assert.equal(persisted.connectors.browser?.enabled, true);
    assert.deepEqual(persisted.connectors.browser?.claimedComputerApps, ['com.google.Chrome']);
    assert.match(persisted.connectors.browser?.args[0] ?? '', /browser-connector\.mjs$/);
    assert.equal(result.connectors.removedRetired, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
