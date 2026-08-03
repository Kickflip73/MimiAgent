import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

interface ProtocolMessage {
  type: string;
  id?: string;
  ok?: boolean;
  error?: string;
  inbound?: string;
  outbound?: string;
  eventAcknowledgement?: boolean;
  result?: Record<string, unknown>;
}

const connector = fileURLToPath(
  new URL('../examples/connectors/personal-message-connector.mjs', import.meta.url),
);

test('personal message health actions enable the bounded recovery probe by default', async () => {
  const source = await readFile(connector, 'utf8');
  assert.match(source, /message\.action === 'health_check'\) return reportHealth\(payload\.probe !== false\)/);
});

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
    assert.equal(sync.ok, false);
    assert.match(sync.error ?? '', /unsupported action: sync_now/);

    child.stdin.write(`${JSON.stringify({
      type: 'action',
      id: 'owner-send-1',
      action: 'send_to_owner',
      target: 'owner',
      payload: { text: 'hello' },
      deadlineAt: Date.now() + 2_000,
    })}\n`);
    const ownerSend = await waitFor(messages, (message) => message.id === 'owner-send-1');
    assert.equal(ownerSend.ok, true);
    assert.equal(ownerSend.result?.status, 'failed');
    assert.match(String(ownerSend.result?.error), /owner account or self conversation is not ready/);
  } finally {
    await stop(child);
  }
});

test('Connector host does not impersonate the QQ Computer route', async () => {
  const child = spawn(process.execPath, [connector, '--channel=qq'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /not implemented/);
});
