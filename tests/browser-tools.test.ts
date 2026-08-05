import assert from 'node:assert/strict';
import test from 'node:test';
import { RunContext } from '@openai/agents';
import { ActionFailedSafeError } from '../src/core/action-intent.js';
import {
  BrowserRunManager,
  type BrowserCapabilityRequest,
  type BrowserCapabilityResult,
} from '../src/extensions/browser/manager.js';
import { browserLedgerArguments, createBrowserTools } from '../src/extensions/browser/tools.js';

class FakeBrowserExecutor {
  readonly calls: BrowserCapabilityRequest[] = [];

  async execute(request: BrowserCapabilityRequest): Promise<BrowserCapabilityResult> {
    this.calls.push(request);
    if (request.action === 'open_session') {
      return {
        connector: 'browser',
        effect: 'write',
        result: { sessionRef: 'browser:private-handle', outcome: 'confirmed', opened: true },
      };
    }
    if (request.action === 'close_session') {
      return { connector: 'browser', effect: 'write', result: { closed: true, outcome: 'confirmed' } };
    }
    return {
      connector: 'browser',
      effect: request.action === 'snapshot' || request.action === 'wait' ? 'read' : 'write',
      result: { sessionRef: 'browser:private-handle', title: 'Fixture', outcome: 'confirmed' },
    };
  }
}

function invokable(tools: ReturnType<typeof createBrowserTools>, name: string) {
  const selected = tools.find((candidate) => candidate.name === name);
  assert.ok(selected && 'invoke' in selected);
  return selected;
}

test('Browser tools are strict, direct, and keep Connector session handles inside the Host', async () => {
  const executor = new FakeBrowserExecutor();
  const manager = new BrowserRunManager('event / 1', (request) => executor.execute(request));
  const tools = createBrowserTools(manager);
  assert.deepEqual(tools.map((tool) => tool.name), [
    'browser_open',
    'browser_observe',
    'browser_act',
    'browser_wait',
    'browser_assert',
    'browser_close',
  ]);
  assert.ok(tools.every((tool) => tool.type === 'function' && tool.strict === true));
  assert.doesNotMatch(
    JSON.stringify(tools.map((tool) => (tool as unknown as { parameters?: unknown }).parameters)),
    /sessionRef|connector|capability/,
  );
  assert.doesNotMatch(
    JSON.stringify(tools.map((tool) => (tool as unknown as { parameters?: unknown }).parameters)),
    /"format":"uri"/,
  );
  const browserSchema = JSON.stringify(
    tools.map((tool) => (tool as unknown as { parameters?: unknown }).parameters),
  );
  assert.doesNotMatch(browserSchema, /"ax"/);

  const context = new RunContext({});
  const opened = await invokable(tools, 'browser_open').invoke(
    context,
    JSON.stringify({ url: 'https://example.com' }),
  );
  assert.doesNotMatch(JSON.stringify(opened), /private-handle|sessionRef/);
  await invokable(tools, 'browser_observe').invoke(
    context,
    JSON.stringify({ operation: 'snapshot' }),
  );
  await invokable(tools, 'browser_observe').invoke(
    context,
    JSON.stringify({
      operation: 'read_element',
      selector: 'h1',
      name: 'h1',
      role: null,
      page: null,
    }),
  );
  await invokable(tools, 'browser_act').invoke(
    context,
    JSON.stringify({ operation: 'click', role: 'button', name: 'Continue' }),
  );
  await invokable(tools, 'browser_act').invoke(
    context,
    JSON.stringify({ operation: 'fill', label: 'Name', value: 'Mimi' }),
  );
  await invokable(tools, 'browser_act').invoke(
    context,
    JSON.stringify({ operation: 'select', label: 'Role', value: 'Designer' }),
  );
  await invokable(tools, 'browser_act').invoke(
    context,
    JSON.stringify({ operation: 'check', label: 'Active' }),
  );
  const asserted = await invokable(tools, 'browser_assert').invoke(
    context,
    JSON.stringify({ kind: 'text', value: 'Done', timeoutMs: 2_000 }),
  );
  assert.match(JSON.stringify(asserted), /verified/);
  await invokable(tools, 'browser_close').invoke(context, '{}');

  const targets = new Set(executor.calls.map((call) => call.target));
  assert.equal(targets.size, 1);
  assert.match([...targets][0]!, /^mimi-browser-[a-f0-9]{16}$/);
  assert.deepEqual(executor.calls.map((call) => [call.capability, call.action]), [
    ['browser.session.write', 'open_session'],
    ['browser.page.snapshot', 'snapshot'],
    ['browser.element.read', 'read_element'],
    ['browser.element.write', 'click'],
    ['browser.element.write', 'fill'],
    ['browser.element.write', 'select'],
    ['browser.element.write', 'check'],
    ['browser.page.wait', 'wait'],
    ['browser.session.write', 'close_session'],
  ]);
  assert.deepEqual(executor.calls[2]?.payload, { selector: 'h1' });
  assert.deepEqual(executor.calls[3]?.payload, { role: 'button', name: 'Continue' });
  assert.deepEqual(executor.calls[4]?.payload, { role: 'textbox', name: 'Name', value: 'Mimi' });
  assert.deepEqual(executor.calls[5]?.payload, { role: 'combobox', name: 'Role', value: 'Designer' });
  assert.deepEqual(executor.calls[6]?.payload, { role: 'checkbox', name: 'Active' });
  assert.equal(executor.calls[1]?.payload.source, 'dom');
});

test('Browser run cleanup closes an owned session exactly once', async () => {
  const executor = new FakeBrowserExecutor();
  const manager = new BrowserRunManager('cleanup-run', (request) => executor.execute(request));
  await manager.open({ url: 'https://example.com' });
  await manager.endRun();
  await manager.endRun();
  assert.equal(executor.calls.filter((call) => call.action === 'close_session').length, 1);
});

test('Browser tab actions omit SDK null placeholders before Connector dispatch', async () => {
  const executor = new FakeBrowserExecutor();
  const manager = new BrowserRunManager('null-tab-page', (request) => executor.execute(request));
  const tools = createBrowserTools(manager);
  const context = new RunContext({});
  await manager.open({ url: 'https://example.com' });
  await invokable(tools, 'browser_act').invoke(
    context,
    JSON.stringify({ operation: 'close_tab', page: null }),
  );
  assert.deepEqual(executor.calls.at(-1)?.payload, {});
  await manager.close();
});

test('Browser close before open is a no-op and does not consume the run session lifecycle', async () => {
  const executor = new FakeBrowserExecutor();
  const manager = new BrowserRunManager('close-before-open', (request) => executor.execute(request));
  await manager.close();
  await manager.open({ url: 'https://example.com' });
  await manager.endRun();
  assert.deepEqual(executor.calls.map((call) => call.action), ['open_session', 'close_session']);
});

test('Browser run fails closed after an uncertain open and performs one cleanup attempt', async () => {
  const calls: BrowserCapabilityRequest[] = [];
  const manager = new BrowserRunManager('uncertain-open', async (request) => {
    calls.push(request);
    if (request.action === 'open_session') {
      return { connector: 'browser', effect: 'write', result: { outcome: 'accepted' } };
    }
    return { connector: 'browser', effect: 'write', result: { outcome: 'confirmed', closed: true } };
  });

  await manager.open({ url: 'https://example.com' });
  await assert.rejects(
    () => manager.observe('snapshot', 'browser.page.snapshot', {}),
    /browser_session_uncertain/,
  );
  await manager.endRun();
  await manager.endRun();
  assert.equal(calls.filter((call) => call.action === 'close_session').length, 1);
});

test('Browser run only clears cleanup responsibility for a declared failed-safe open', async () => {
  for (const errorName of ['ActionFailedSafeError', 'UncertainDeliveryError']) {
    const calls: BrowserCapabilityRequest[] = [];
    const openError = new Error(errorName);
    openError.name = errorName;
    const manager = new BrowserRunManager(`failed-open-${errorName}`, async (request) => {
      calls.push(request);
      if (request.action === 'open_session') throw openError;
      return { connector: 'browser', effect: 'write', result: { outcome: 'confirmed', closed: true } };
    });

    await assert.rejects(() => manager.open({ url: 'https://example.com' }), openError);
    await manager.endRun();
    assert.equal(
      calls.filter((call) => call.action === 'close_session').length,
      errorName === 'ActionFailedSafeError' ? 0 : 1,
    );
  }
});

test('Browser tools expose failed-safe and uncertain action errors without generic SDK wrapping', async () => {
  for (const [error, expected] of [
    [new ActionFailedSafeError('capability_unavailable: browser is stale'), 'action_failed_safe'],
    [new Error('transport lost after dispatch'), 'action_uncertain'],
  ] as const) {
    const manager = new BrowserRunManager(`structured-${expected}`, async () => {
      throw error;
    });
    const result = await invokable(createBrowserTools(manager), 'browser_open').invoke(
      new RunContext({}),
      JSON.stringify({ url: 'https://example.com' }),
    );
    const parsed = JSON.parse(String(result)) as Record<string, unknown>;
    assert.equal(parsed.mimiStatus, expected);
    assert.doesNotMatch(String(parsed.message), /An error occurred while running the tool/);
    assert.equal(parsed.sideEffectsFrozen, expected === 'action_uncertain');
  }
});

test('Browser run never replays an uncertain close during Host cleanup', async () => {
  const calls: BrowserCapabilityRequest[] = [];
  const closeError = new Error('transport lost after close dispatch');
  const manager = new BrowserRunManager('uncertain-close', async (request) => {
    calls.push(request);
    if (request.action === 'close_session') throw closeError;
    return { connector: 'browser', effect: 'write', result: { outcome: 'confirmed' } };
  });

  await manager.open({ url: 'https://example.com' });
  await assert.rejects(() => manager.close(), closeError);
  await assert.rejects(() => manager.endRun(), closeError);
  assert.equal(calls.filter((call) => call.action === 'close_session').length, 1);
});

test('Browser model results stay within 16 KiB after Unicode and JSON escaping', async () => {
  const manager = new BrowserRunManager('bounded-result', async (request) => ({
    connector: 'browser',
    effect: request.action === 'open_session' ? 'write' : 'read',
    result: request.action === 'open_session'
      ? { outcome: 'confirmed' }
      : { content: `${'界面"\\'.repeat(20_000)}` },
  }));
  await manager.open({ url: 'https://example.com' });
  const result = await manager.observe('extract', 'browser.page.read', {});

  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 16 * 1024);
  assert.equal((result as { truncated?: boolean }).truncated, true);
});

test('Browser manager validates navigation URLs outside provider JSON Schema', async () => {
  const executor = new FakeBrowserExecutor();
  const manager = new BrowserRunManager('url-validation', (request) => executor.execute(request));
  await assert.rejects(() => manager.open({ url: 'file:///etc/passwd' }), /browser_url_invalid/);
  await assert.rejects(() => manager.open({ url: 'https://user:secret@example.com/' }), /browser_url_invalid/);
  await manager.open({ url: 'https://example.com/path' });
  await assert.rejects(
    () => manager.act('navigate', 'browser.navigation.write', { url: 'javascript:alert(1)' }),
    /browser_url_invalid/,
  );
  assert.equal(executor.calls.length, 1);
});

test('Browser ledger arguments redact typed and filled values', () => {
  for (const operation of ['type', 'fill'] as const) {
    const redacted = browserLedgerArguments(JSON.stringify({
      operation,
      role: 'textbox',
      name: 'Secret',
      value: 'private browser value',
    }));
    assert.doesNotMatch(redacted, /private browser value/);
    assert.match(redacted, /valueSha256/);
    assert.match(redacted, /valueLength/);
  }
});
