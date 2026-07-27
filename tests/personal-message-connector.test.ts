import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

interface ProtocolMessage {
  type: string;
  id?: string;
  ok?: boolean;
  inbound?: string;
  outbound?: string;
  eventAcknowledgement?: boolean;
  result?: Record<string, unknown>;
}

const connector = fileURLToPath(
  new URL('../examples/connectors/personal-message-connector.mjs', import.meta.url),
);

async function waitFor(
  messages: ProtocolMessage[],
  predicate: (message: ProtocolMessage) => boolean,
): Promise<ProtocolMessage> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const message = messages.find(predicate);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`protocol message timed out: ${JSON.stringify(messages)}`);
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

test('personal message connector stays diagnosable when Daxiang config is missing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'personal-message-host-'));
  const child = spawn(process.execPath, [connector, '--channel=daxiang'], {
    env: {
      ...process.env,
      MIMI_DAEMON_DATA_DIR: root,
      DAXIANG_WEB_CONFIG: path.join(root, 'missing.json'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages: ProtocolMessage[] = [];
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    while (stdout.includes('\n')) {
      const newline = stdout.indexOf('\n');
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line) messages.push(JSON.parse(line) as ProtocolMessage);
    }
  });
  try {
    const status = await waitFor(messages, (message) => (
      message.type === 'status' && message.inbound === 'unavailable'
    ));
    assert.equal(status.outbound, 'unavailable');
    assert.equal(status.eventAcknowledgement, true);

    child.stdin.write(`${JSON.stringify({
      type: 'action',
      id: 'health-1',
      action: 'health_check',
      target: 'account',
      payload: { probe: true },
      deadlineAt: Date.now() + 2_000,
    })}\n`);
    const result = await waitFor(messages, (message) => message.id === 'health-1');
    assert.equal(result.ok, true);
    assert.equal(result.result?.accountVerified, false);

    child.stdin.write(`${JSON.stringify({
      type: 'action',
      id: 'sync-1',
      action: 'sync_now',
      target: 'all',
      payload: {},
      deadlineAt: Date.now() + 2_000,
    })}\n`);
    const sync = await waitFor(messages, (message) => message.id === 'sync-1');
    assert.equal(sync.ok, true);
    assert.equal(sync.result?.emitted, 0);
    assert.equal(sync.result?.pending, false);
    assert.equal(sync.result?.actionActive, undefined);
  } finally {
    await stop(child);
  }
});

test('QQ and WeChat do not have placeholder adapters', async () => {
  for (const channel of ['qq', 'wechat']) {
    const child = spawn(process.execPath, [connector, `--channel=${channel}`], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const exitCode = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    assert.notEqual(exitCode, 0);
    assert.match(stderr, /not implemented/);
  }
});
