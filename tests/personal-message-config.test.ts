import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  ConnectorManager,
  connectorCapabilityActionReady,
  parseConnectorConfig,
  type ConnectorCapability,
} from '../src/daemon/connectors.js';
import { NotifierRegistry } from '../src/daemon/notifier.js';
import { MimiStore } from '../src/daemon/store.js';

test('default connector templates exclude personal and retired message backends', async () => {
  const template = parseConnectorConfig(JSON.parse(
    await readFile(path.join(process.cwd(), 'mimi.connectors.example.json'), 'utf8'),
  ));
  assert.equal(template.connectors['personal-qq'], undefined);
  assert.equal(template.connectors['personal-wechat'], undefined);
  assert.equal(template.connectors['openclaw-weixin'], undefined);
});

test('M1 execution surfaces have stable capability, effect, and route ownership metadata', async () => {
  const template = parseConnectorConfig(JSON.parse(
    await readFile(path.join(process.cwd(), 'mimi.connectors.example.json'), 'utf8'),
  ));
  for (const id of [
    'browser', 'macos-screen', 'macos-shortcuts', 'macos-desktop',
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
  assert.equal(template.connectors['macos-desktop']?.actions.activate_app?.targetExample, 'org.example.App');
  assert.equal(template.connectors['macos-desktop']?.actions.activate_app?.payloadExampleJson, '{}');
  assert.match(
    template.connectors['macos-desktop']?.actions.open_visible?.payloadExampleJson ?? '',
    /bundleId/,
  );
});

test('personal target binding is available from verified inbound readiness before send is ready', () => {
  const connector: ConnectorCapability = {
    id: 'personal-qq',
    enabled: true,
    online: true,
    readiness: {
      inbound: 'ready',
      outbound: 'unavailable',
      accountVerified: true,
      backgroundSafe: true,
    },
    source: 'personal-message:qq',
    trust: 'external',
    claimedComputerApps: [],
    actions: [{
      name: 'bind_target',
      description: 'bind',
      capability: 'personal-message.target.bind',
      effect: 'write',
      routeOwner: 'personal-qq',
    }],
  };
  const action = connector.actions[0]!;
  assert.equal(connectorCapabilityActionReady(connector, action), true);
  assert.equal(connectorCapabilityActionReady({
    ...connector,
    readiness: { ...connector.readiness, accountVerified: false },
  }, action), false);
  assert.equal(connectorCapabilityActionReady({
    ...connector,
    readiness: { ...connector.readiness, backgroundSafe: false },
  }, action), false);
});

test('generic connector_action cannot reach personal-message send_message', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'personal-message-action-'));
  const configFile = path.join(root, 'connectors.json');
  await writeFile(configFile, `${JSON.stringify({
    backgroundDefaultsVersion: 2,
    connectors: {
      'personal-qq': {
        enabled: false,
        command: process.execPath,
        args: [],
        source: 'personal-message:qq',
        trust: 'external',
        profileId: 'owner',
        restart: false,
        actions: {
          send_message: { description: 'bound only', modelVisible: false },
          get_context: { description: 'read' },
        },
      },
    },
  })}\n`);
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const manager = await ConnectorManager.load(configFile, store, new NotifierRegistry());
    await assert.rejects(() => manager.executeAction({
      connector: 'personal-qq',
      action: 'send_message',
      target: '123',
      payload: { text: 'hello' },
    }), /Host 内部能力/);
    await assert.rejects(() => manager.executePersonalMessageAction({
      connector: 'personal-qq',
      action: 'unknown',
      target: '123',
      payload: {},
    }), /不允许 action/);
    await assert.rejects(() => manager.executePersonalMessageAction({
      connector: 'personal-qq',
      action: 'sync_now',
      target: 'all',
      payload: {},
    }), /不允许 action/);
  } finally {
    store.close();
  }
});

test('desktop connector cannot take over a resource claimed by another enabled route owner', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'connector-route-owner-'));
  const configFile = path.join(root, 'connectors.json');
  await writeFile(configFile, `${JSON.stringify({
    backgroundDefaultsVersion: 2,
    connectors: {
      'personal-channel': {
        enabled: true,
        command: process.execPath,
        args: [],
        source: 'personal-message:fixture',
        trust: 'external',
        profileId: 'owner',
        restart: false,
        claimedComputerApps: ['com.example.personal'],
        actions: {
          get_context: {
            description: 'read context',
            capability: 'personal-message.context.read',
            effect: 'read',
          },
        },
      },
      'desktop-control': {
        enabled: true,
        command: process.execPath,
        args: [],
        source: 'desktop:fixture',
        trust: 'owner',
        profileId: 'owner',
        restart: false,
        actions: {
          activate_app: {
            description: 'activate app',
            capability: 'desktop.apps.activate',
            effect: 'write',
          },
        },
      },
    },
  })}\n`);
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const manager = await ConnectorManager.load(configFile, store, new NotifierRegistry());
    await assert.rejects(() => manager.executeAction({
      connector: 'desktop-control',
      action: 'activate_app',
      target: 'com.example.personal',
      payload: {},
    }), /route_owner_conflict|不得跨执行面接管/);
  } finally {
    store.close();
  }
});
