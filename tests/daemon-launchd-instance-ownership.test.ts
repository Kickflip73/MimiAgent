import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../src/config.js';
import {
  launchAgentPlist,
  launchAgentPlistBelongsTo,
} from '../src/daemon/launch-agent-config.js';
import { installLaunchAgentPlistFile } from '../src/daemon/service.js';

function config(root: string, instance: string): AppConfig {
  return {
    provider: 'openai',
    workspaceRoot: path.join(root, instance, 'workspace'),
    dataRoot: path.join(root, instance, 'data'),
    daemonDataRoot: path.join(root, instance, 'daemon'),
    skillsRoot: path.join(root, instance, 'skills'),
    mcpConfig: path.join(root, instance, 'mcp.json'),
    historyLimit: 40,
    maxTurns: null,
  };
}

test('normal startup uses launchd only when the global plist belongs to this Mimi instance', () => {
  const root = path.join(os.tmpdir(), 'mimi-launchd-owner-fixture');
  const first = config(root, 'first');
  const second = config(root, 'second');
  const plist = launchAgentPlist(first, '/tmp/mimi-entry.js', []);

  assert.equal(launchAgentPlistBelongsTo(plist, first), true);
  assert.equal(launchAgentPlistBelongsTo(plist, second), false);
});

test('concurrent installs serialize and reject a different instance without corrupting the plist', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-launchd-install-owner-'));
  const file = path.join(root, 'LaunchAgents', 'com.mimiagent.daemon.plist');
  const first = config(root, 'first');
  const second = config(root, 'second');
  const installedBy: string[] = [];

  const results = await Promise.allSettled([
    installLaunchAgentPlistFile(first, file, async () => { installedBy.push('first'); }, '/tmp/mimi-entry.js', []),
    installLaunchAgentPlistFile(second, file, async () => { installedBy.push('second'); }, '/tmp/mimi-entry.js', []),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejection = results.find((result) => result.status === 'rejected');
  assert.ok(rejection?.status === 'rejected');
  assert.match(String(rejection.reason), /属于另一个 MimiAgent 数据目录/);
  assert.equal(installedBy.length, 1);
  const installed = await readFile(file, 'utf8');
  const winner = installedBy[0] === 'first' ? first : second;
  const loser = installedBy[0] === 'first' ? second : first;
  assert.equal(launchAgentPlistBelongsTo(installed, winner), true);
  assert.equal(launchAgentPlistBelongsTo(installed, loser), false);
});
