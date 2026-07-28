import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ConnectorManager, parseConnectorConfig } from '../src/daemon/connectors.js';
import { NotifierRegistry } from '../src/daemon/notifier.js';
import { MimiStore } from '../src/daemon/store.js';

test('personal channel templates are disabled and only Daxiang declares actions', async () => {
  const template = parseConnectorConfig(JSON.parse(
    await readFile(path.join(process.cwd(), 'mimi.connectors.example.json'), 'utf8'),
  ));
  const daxiang = template.connectors['personal-daxiang'];
  const qq = template.connectors['personal-qq'];
  const wechat = template.connectors['personal-wechat'];
  assert.ok(daxiang && qq && wechat);
  assert.equal(daxiang.enabled, false);
  assert.deepEqual(Object.keys(daxiang.actions).sort(), [
    'get_context', 'health_check', 'list_targets', 'send_message', 'sync_now',
  ]);
  assert.equal(qq.enabled, false);
  assert.deepEqual(qq.actions, {});
  assert.equal(wechat.enabled, false);
  assert.deepEqual(wechat.actions, {});
});

test('M1 execution surfaces have stable capability, effect, and route ownership metadata', async () => {
  const template = parseConnectorConfig(JSON.parse(
    await readFile(path.join(process.cwd(), 'mimi.connectors.example.json'), 'utf8'),
  ));
  for (const id of [
    'macos-browser', 'macos-screen', 'macos-shortcuts', 'macos-desktop', 'personal-daxiang',
  ]) {
    const connector = template.connectors[id];
    assert.ok(connector, id);
    for (const [name, action] of Object.entries(connector.actions)) {
      assert.ok(action.capability, `${id}.${name} capability`);
      assert.notEqual(action.effect, 'unknown', `${id}.${name} effect`);
    }
  }
  assert.equal(template.connectors['macos-shortcuts']?.actions.run_shortcut?.effect, 'write');
  assert.equal(template.connectors['macos-screen']?.actions.read_screen?.effect, 'read');
  assert.equal(template.connectors['personal-daxiang']?.actions.send_message?.capability, 'personal-message.send');
});

test('generic connector_action cannot reach personal-message send_message', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'personal-message-action-'));
  const configFile = path.join(root, 'connectors.json');
  await writeFile(configFile, `${JSON.stringify({
    backgroundDefaultsVersion: 2,
    connectors: {
      'personal-daxiang': {
        enabled: false,
        command: process.execPath,
        args: [],
        source: 'personal-message:daxiang',
        trust: 'external',
        profileId: 'owner',
        restart: false,
        actions: {
          send_message: { description: 'bound only' },
          get_context: { description: 'read' },
        },
      },
    },
  })}\n`);
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const manager = await ConnectorManager.load(configFile, store, new NotifierRegistry());
    await assert.rejects(() => manager.executeAction({
      connector: 'personal-daxiang',
      action: 'send_message',
      target: '123',
      payload: { text: 'hello' },
    }), /PersonalMessageHub/);
    await assert.rejects(() => manager.executePersonalMessageAction({
      connector: 'personal-daxiang',
      action: 'unknown',
      target: '123',
      payload: {},
    }), /不允许 action/);
  } finally {
    store.close();
  }
});
