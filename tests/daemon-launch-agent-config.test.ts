import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../src/config.js';
import {
  daemonLaunchEnvironment,
  launchAgentPlist,
} from '../src/daemon/launch-agent-config.js';

const CONNECTOR_CONFIG_MODE = 'MIMI_CONNECTORS_CONFIG_MODE';

const config: AppConfig = {
  provider: 'openai',
  workspaceRoot: path.resolve('/tmp/mimi-launch-workspace'),
  dataRoot: path.resolve('/tmp/mimi-launch-data'),
  daemonDataRoot: path.resolve('/tmp/mimi-launch-daemon'),
  skillsRoot: path.resolve('/tmp/mimi-launch-skills'),
  mcpConfig: path.resolve('/tmp/mimi-launch-mcp.json'),
  historyLimit: 40,
  maxTurns: 200,
};

function withConnectorConfigMode<T>(value: string | undefined, operation: () => T): T {
  const previous = process.env[CONNECTOR_CONFIG_MODE];
  if (value === undefined) delete process.env[CONNECTOR_CONFIG_MODE];
  else process.env[CONNECTOR_CONFIG_MODE] = value;
  try {
    return operation();
  } finally {
    if (previous === undefined) delete process.env[CONNECTOR_CONFIG_MODE];
    else process.env[CONNECTOR_CONFIG_MODE] = previous;
  }
}

test('LaunchAgent preserves exact connector configuration without changing managed defaults', () => {
  const managed = withConnectorConfigMode(undefined, () => daemonLaunchEnvironment(config));
  assert.equal(Object.hasOwn(managed, CONNECTOR_CONFIG_MODE), false);

  const exact = withConnectorConfigMode('exact', () => daemonLaunchEnvironment(config));
  assert.equal(exact[CONNECTOR_CONFIG_MODE], 'exact');

  const plist = withConnectorConfigMode('exact', () => launchAgentPlist(config, '/tmp/mimi-entry.js', []));
  assert.match(plist, /<key>MIMI_CONNECTORS_CONFIG_MODE<\/key>\s*<string>exact<\/string>/u);
});

test('LaunchAgent rejects unknown connector configuration modes', () => {
  assert.throws(
    () => withConnectorConfigMode('append', () => daemonLaunchEnvironment(config)),
    /MIMI_CONNECTORS_CONFIG_MODE.*exact/u,
  );
});
