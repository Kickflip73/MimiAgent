import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

interface Message {
  type: string;
  id?: string;
  ok?: boolean;
  uncertain?: boolean;
  result?: Record<string, unknown>;
  error?: string;
  inbound?: string;
  outbound?: string;
  coverage?: string;
}

async function waitFor(messages: Message[], id: string): Promise<Message> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const message = messages.find((item) => item.id === id);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`message timed out: ${JSON.stringify(messages)}`);
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

test('Browser Connector exposes bounded OpenCLI Chrome sessions without observation gates', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-connector-'));
  const commandLog = path.join(root, 'commands.ndjson');
  const mockOpenCli = path.join(root, 'mock-opencli.mjs');
  await writeFile(mockOpenCli, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(commandLog)}, JSON.stringify(args) + '\\n');
if (args[0] === 'daemon' && args[1] === 'status') {
  process.stdout.write('Daemon: running (PID 123)\\nExtension: connected (v1.0.22)\\n');
  process.exit(0);
}
if (args[0] === 'doctor') throw new Error('doctor must not be invoked');
const [, session, command, subcommand, ...rest] = args;
if (!session.startsWith('mimi-')) throw new Error('unexpected session');
if (command === 'open') process.stdout.write(JSON.stringify({ url: subcommand, page: 'page-1' }));
else if (command === 'bind') process.stdout.write(JSON.stringify({ session, bound: true }));
else if (command === 'close' || command === 'unbind') process.stdout.write(JSON.stringify({ released: true }));
else if (command === 'state') process.stdout.write('URL: https://example.com\\n[7] button "Save"');
else if (command === 'find') process.stdout.write(JSON.stringify({ matches_n: 1, entries: [{ ref: 7, role: 'button', text: 'Save' }] }));
else if (command === 'tab' && subcommand === 'list') process.stdout.write(JSON.stringify([{ page: 'page-1', url: 'https://example.com' }]));
else if (command === 'get' && subcommand === 'html') process.stdout.write(JSON.stringify({ tag: 'body', text: 'Example' }));
else if (command === 'get' && subcommand === 'text') process.stdout.write(JSON.stringify({ value: 'Save', matches_n: 1, match_level: 'exact' }));
else if (command === 'extract') process.stdout.write(JSON.stringify({ url: 'https://internal.example.com/issues/1', content: '# Internal issue', next_start_char: null }));
else if (command === 'network') process.stdout.write(JSON.stringify([{ url: 'https://example.com/api?token=secret', body: { token: 'secret' }, shape: ['items'] }]));
else if (command === 'click') process.stdout.write(JSON.stringify({ clicked: true, target: subcommand, matches_n: 1, match_level: 'exact' }));
else if (command === 'eval') process.stdout.write(JSON.stringify({ value: 'script-result', script: subcommand }));
else if (command === 'fill') {
  const value = rest[0];
  process.stdout.write(JSON.stringify({ filled: true, verified: true, target: subcommand, text: value, actual: value, matches_n: 1, match_level: 'exact' }));
}
else process.stdout.write(JSON.stringify({ command, subcommand, rest }));
`);
  await chmod(mockOpenCli, 0o755);

  const connector = fileURLToPath(
    new URL('../examples/connectors/browser-connector.mjs', import.meta.url),
  );
  const child = spawn(process.execPath, [connector], {
    env: {
      ...process.env,
      OPENCLI_BIN: mockOpenCli,
      OPENCLI_BROWSER_COMMAND_TIMEOUT_MS: '2000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages: Message[] = [];
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    while (stdout.includes('\n')) {
      const newline = stdout.indexOf('\n');
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line) messages.push(JSON.parse(line) as Message);
    }
  });
  const call = async (
    id: string,
    action: string,
    target: string,
    payload: unknown,
  ): Promise<Message> => {
    child.stdin.write(`${JSON.stringify({ type: 'action', id, action, target, payload })}\n`);
    return waitFor(messages, id);
  };

  try {
    const readinessDeadline = Date.now() + 2_000;
    while (!messages.some((message) => message.type === 'status')
      && Date.now() < readinessDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(messages.find((message) => message.type === 'status'), {
      type: 'status',
      inbound: 'unavailable',
      outbound: 'ready',
      deliveryConfirmed: false,
      coverage: 'bounded',
      backgroundSafe: true,
    });

    const health = await call('health', 'doctor', 'health', {});
    assert.equal(health.ok, true, health.error);
    assert.deepEqual(health.result, {
      daemon: 'running',
      extension: 'connected',
      ready: true,
      probe: 'daemon_status',
    });

    const authenticatedPage = await call(
      'read-url',
      'read_url',
      'https://internal.example.com/issues/1',
      {},
    );
    assert.equal(authenticatedPage.ok, true, authenticatedPage.error);
    assert.equal(authenticatedPage.result?.requestedUrl, 'https://internal.example.com/issues/1');
    assert.equal(authenticatedPage.result?.content, '# Internal issue');
    assert.equal(authenticatedPage.result?.sessionReleased, true);
    assert.equal(authenticatedPage.result?.untrusted, true);

    const opened = await call('open', 'open_session', 'research', {
      url: 'https://example.com',
    });
    assert.equal(opened.ok, true, opened.error);
    assert.equal(opened.result?.outcome, 'confirmed');
    assert.equal(opened.result?.kind, 'owned');
    const sessionRef = String(opened.result?.sessionRef);
    assert.match(sessionRef, /^browser:/);

    const foreground = await call('foreground', 'open_session', 'foreground', {
      url: 'https://example.com',
      window: 'foreground',
    });
    assert.equal(foreground.ok, false);
    assert.match(foreground.error ?? '', /foreground browser sessions are disabled/);

    const snapshot = await call('snapshot', 'snapshot', sessionRef, {
      source: 'dom',
    });
    assert.equal(snapshot.ok, true, snapshot.error);
    assert.match(String(snapshot.result?.observationId), /^[0-9a-f-]{36}$/);
    assert.match(String(snapshot.result?.text), /button "Save"/);
    const observationId = String(snapshot.result?.observationId);

    const rejected = await call('rejected-click', 'click', sessionRef, {
      observationId,
      ref: 7,
      element: '7',
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error ?? '', /use only one of payload\.ref.*payload\.element/);

    const newerObservation = await call('newer-observation', 'find', sessionRef, {
      role: 'button',
      name: 'Save',
    });
    assert.notEqual(newerObservation.result?.observationId, observationId);
    const clicked = await call('click', 'click', sessionRef, { ref: 7 });
    assert.equal(clicked.ok, true, clicked.error);
    assert.equal(clicked.result?.outcome, 'confirmed');
    assert.equal(clicked.result?.completionScope, 'interaction');
    assert.equal(clicked.result?.businessOutcome, 'unverified');
    assert.equal(clicked.result?.clicked, true);
    assert.equal(clicked.result?.observationInvalidated, undefined);
    assert.deepEqual(clicked.result?.nextRead, {
      action: 'list_tabs',
      reason: '点击可能打开或选择新标签页；先重新列出 page，再读取目标 page',
    });

    const unobservedEval = await call('unobserved-eval', 'execute_javascript', sessionRef, {
      code: 'document.title',
    });
    assert.equal(unobservedEval.ok, true, unobservedEval.error);
    assert.equal(unobservedEval.result?.value, 'script-result');

    const evalSnapshot = await call('eval-snapshot', 'snapshot', sessionRef, {
      source: 'dom',
    });
    const evaluated = await call('eval', 'execute_javascript', sessionRef, {
      observationId: String(evalSnapshot.result?.observationId),
      code: 'document.title',
    });
    assert.equal(evaluated.ok, true, evaluated.error);
    assert.equal(evaluated.result?.outcome, 'confirmed');
    assert.equal(evaluated.result?.observationInvalidated, undefined);
    assert.equal(evaluated.result?.completionScope, 'interaction');
    assert.equal(evaluated.result?.businessOutcome, 'unverified');
    assert.equal(evaluated.result?.value, 'script-result');

    const foundButton = await call('find-button', 'find', sessionRef, {
      role: 'button',
      name: 'Save',
    });
    const hoverObservation = String(foundButton.result?.observationId);
    const hovered = await call('hover', 'hover', sessionRef, {
      observationId: hoverObservation,
      locator: 7,
    });
    assert.equal(hovered.ok, true, hovered.error);
    assert.equal(hovered.result?.outcome, 'confirmed');

    const oldObservation = await call('old-observation', 'click', sessionRef, {
      observationId,
      element: '7',
    });
    assert.equal(oldObservation.ok, true, oldObservation.error);

    const found = await call('find', 'find', sessionRef, {
      role: 'textbox',
      name: 'Password',
    });
    const fillObservation = String(found.result?.observationId);
    const filled = await call('fill', 'fill', sessionRef, {
      observationId: fillObservation,
      element: '#password',
      value: 'never-persist-this',
    });
    assert.equal(filled.ok, true, filled.error);
    assert.equal(filled.result?.verified, true);
    assert.equal(filled.result?.text, undefined);
    assert.equal(filled.result?.actual, undefined);
    assert.equal(filled.result?.textLength, 18);

    const page = await call('page', 'read_page', sessionRef, {
      format: 'json',
      maxChars: 1_000,
    });
    assert.deepEqual(page.result, {
      tag: 'body',
      text: 'Example',
      untrusted: true,
    });

    const network = await call('network', 'network', sessionRef, {});
    const entries = network.result?.entries as Array<Record<string, unknown>>;
    assert.equal(entries[0]?.url, 'https://example.com/api');
    assert.equal(entries[0]?.body, '[REDACTED]');

    const closed = await call('close', 'close_session', sessionRef, {});
    assert.equal(closed.ok, true, closed.error);
    assert.equal(closed.result?.closed, true);
    assert.equal(closed.result?.outcome, 'confirmed');

    const expired = await call('expired', 'snapshot', sessionRef, {});
    assert.equal(expired.ok, false);
    assert.match(expired.error ?? '', /missing or expired/);

    const commands = (await readFile(commandLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    assert.ok(commands.some((args) => args[0] === 'daemon' && args[1] === 'status'));
    assert.ok(commands.every((args) => args[0] !== 'doctor'));
    assert.ok(commands.some((args) => args[1]?.startsWith('mimi-read-') && args[2] === 'open'));
    assert.ok(commands.some((args) => args[1]?.startsWith('mimi-read-') && args[2] === 'extract'));
    assert.ok(commands.some((args) => args[1]?.startsWith('mimi-read-') && args[2] === 'close'));
    assert.ok(commands.some((args) => args.includes('--window') && args.includes('background')));
    assert.ok(commands.every((args) => !args.includes('foreground')));
    assert.ok(commands.every((args) => !args.some((arg) => /safari|osascript/i.test(arg))));
  } finally {
    await stop(child);
  }
});

test('Browser Connector reports unavailable when OpenCLI status cannot start', async () => {
  const connector = fileURLToPath(
    new URL('../examples/connectors/browser-connector.mjs', import.meta.url),
  );
  const child = spawn(process.execPath, [connector], {
    env: {
      ...process.env,
      OPENCLI_BIN: '/definitely/missing/opencli',
      OPENCLI_BROWSER_COMMAND_TIMEOUT_MS: '1000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages: Message[] = [];
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    while (stdout.includes('\n')) {
      const newline = stdout.indexOf('\n');
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line) messages.push(JSON.parse(line) as Message);
    }
  });
  try {
    const deadline = Date.now() + 2_000;
    while (!messages.some((message) => message.type === 'status') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(messages.find((message) => message.type === 'status'), {
      type: 'status',
      inbound: 'unavailable',
      outbound: 'unavailable',
      deliveryConfirmed: false,
      coverage: 'unavailable',
      backgroundSafe: true,
      reasonCode: 'opencli_unavailable',
    });
  } finally {
    await stop(child);
  }
});

test('Browser Connector reports unavailable when OpenCLI extension is disconnected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-connector-status-'));
  const mockOpenCli = path.join(root, 'mock-opencli.mjs');
  await writeFile(mockOpenCli, `#!/usr/bin/env node
process.stdout.write('Daemon: running (PID 123)\\nExtension: disconnected\\n');
`);
  await chmod(mockOpenCli, 0o755);

  const connector = fileURLToPath(
    new URL('../examples/connectors/browser-connector.mjs', import.meta.url),
  );
  const child = spawn(process.execPath, [connector], {
    env: {
      ...process.env,
      OPENCLI_BIN: mockOpenCli,
      OPENCLI_BROWSER_COMMAND_TIMEOUT_MS: '1000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages: Message[] = [];
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    while (stdout.includes('\n')) {
      const newline = stdout.indexOf('\n');
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line) messages.push(JSON.parse(line) as Message);
    }
  });
  try {
    const deadline = Date.now() + 2_000;
    while (!messages.some((message) => message.type === 'status') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(messages.find((message) => message.type === 'status')?.outbound, 'unavailable');
  } finally {
    await stop(child);
  }
});
