import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BrowserRunManager,
  type BrowserCapabilityRequest,
  type BrowserCapabilityResult,
} from '../src/extensions/browser/manager.js';

interface ConnectorMessage {
  type: string;
  id?: string;
  ok?: boolean;
  uncertain?: boolean;
  result?: unknown;
  error?: string;
  outbound?: string;
}

interface IterationResult {
  iteration: number;
  success: boolean;
  durationMs: number;
  maxPayloadBytes: number;
  sessionLeak: boolean;
  error?: string;
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const connectorPath = path.join(repositoryRoot, 'examples', 'connectors', 'browser-connector.mjs');
const iterations = integerEnvironment('MIMI_E2E_ITERATIONS', 10, 1, 100);

function integerEnvironment(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function percentile(values: readonly number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

class BrowserConnectorClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, {
    resolve: (message: ConnectorMessage) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private output = '';
  private sequence = 0;
  private readiness?: Promise<void>;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private stderr = '';

  constructor() {
    this.child = spawn(process.execPath, [connectorPath], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        OPENCLI_BROWSER_COMMAND_TIMEOUT_MS: process.env.OPENCLI_BROWSER_COMMAND_TIMEOUT_MS ?? '30000',
        OPENCLI_BROWSER_MAX_OUTPUT_BYTES: process.env.OPENCLI_BROWSER_MAX_OUTPUT_BYTES ?? '1000000',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.readiness = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onOutput(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8_000);
    });
    this.child.once('error', (error) => this.fail(error));
    this.child.once('exit', (code, signal) => {
      this.fail(new Error(`Browser Connector exited code=${code ?? 'null'} signal=${signal ?? 'none'}: ${this.stderr.trim()}`));
    });
  }

  async ready(): Promise<void> {
    const timer = setTimeout(() => {
      this.readyReject?.(new Error(`Browser Connector readiness timed out: ${this.stderr.trim()}`));
    }, 20_000);
    try {
      await this.readiness;
    } finally {
      clearTimeout(timer);
    }
  }

  async execute(request: BrowserCapabilityRequest, signal?: AbortSignal): Promise<BrowserCapabilityResult> {
    signal?.throwIfAborted();
    const message = await this.call(request.action, request.target, request.payload);
    signal?.throwIfAborted();
    return {
      connector: 'browser',
      effect: request.capability.endsWith('.read')
        || request.capability.includes('.snapshot')
        || request.capability.includes('.wait')
        ? 'read'
        : 'write',
      result: message.result,
    };
  }

  call(action: string, target: string, payload: unknown): Promise<ConnectorMessage> {
    const id = `browser-e2e-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser Connector action ${action} timed out`));
      }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ type: 'action', id, action, target, payload })}\n`);
    });
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null) return;
    this.child.stdin.end();
    this.child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
        resolve();
      }, 2_000);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private onOutput(chunk: string): void {
    this.output += chunk;
    while (this.output.includes('\n')) {
      const newline = this.output.indexOf('\n');
      const line = this.output.slice(0, newline).trim();
      this.output = this.output.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as ConnectorMessage;
      if (message.type === 'status') {
        if (message.outbound === 'ready') this.readyResolve?.();
        else this.readyReject?.(new Error(`Browser Connector unavailable: ${this.stderr.trim() || JSON.stringify(message)}`));
        continue;
      }
      if (!message.id) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message);
      else {
        const error = new Error(message.error ?? 'Browser Connector action failed');
        if (message.uncertain) error.name = 'BrowserActionUncertainError';
        pending.reject(error);
      }
    }
  }

  private fail(error: Error): void {
    this.readyReject?.(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

async function fixtureServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    if (url.pathname === '/done') {
      response.end(`<!doctype html><html><body><h1>Done</h1><p id="result">Saved ${url.searchParams.get('name') ?? ''}</p><a href="/secondary" target="_blank">Open secondary</a></body></html>`);
      return;
    }
    if (url.pathname === '/secondary') {
      response.end('<!doctype html><html><body><h1>Secondary tab</h1></body></html>');
      return;
    }
    response.end(`<!doctype html>
<html><body>
  <h1>Mimi Browser Fixture</h1>
  <form id="fixture-form">
    <label for="name">Name</label><input id="name" name="name" />
    <label for="flavor">Flavor</label><select id="flavor"><option>Vanilla</option><option>Chocolate</option></select>
    <label><input id="confirm" type="checkbox" /> Confirm</label>
    <button type="submit">Submit</button>
  </form>
  <script>
    document.getElementById('fixture-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const name = document.getElementById('name').value;
      if (!document.getElementById('confirm').checked) return;
      location.href = '/done?name=' + encodeURIComponent(name);
    });
  </script>
</body></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
  server.closeIdleConnections();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function runIteration(
  client: BrowserConnectorClient,
  baseUrl: string,
  iteration: number,
): Promise<IterationResult> {
  const started = Date.now();
  const payloadSizes: number[] = [];
  const manager = new BrowserRunManager(`browser-e2e-${iteration}`, (request, signal) => client.execute(request, signal));
  let failure: string | undefined;
  let sessionLeak = false;
  const capture = (value: unknown) => {
    payloadSizes.push(Buffer.byteLength(JSON.stringify(value)));
    return value;
  };
  try {
    capture(await manager.open({ url: `${baseUrl}/` }));
    const snapshot = capture(await manager.observe('snapshot', 'browser.page.snapshot', { source: 'dom' }));
    if (!/Mimi Browser Fixture/.test(JSON.stringify(snapshot))) throw new Error('initial DOM snapshot did not contain the fixture heading');
    capture(await manager.act('fill', 'browser.element.write', {
      role: 'textbox', name: 'Name', value: `Mimi-${iteration}`,
    }));
    capture(await manager.act('select', 'browser.element.write', {
      role: 'combobox', name: 'Flavor', value: 'Chocolate',
    }));
    capture(await manager.act('check', 'browser.element.write', {
      role: 'checkbox', name: 'Confirm',
    }));
    capture(await manager.act('click', 'browser.element.write', {
      role: 'button', name: 'Submit',
    }));
    capture(await manager.assert({ kind: 'text', value: `Saved Mimi-${iteration}`, timeoutMs: 10_000 }));
    const page = capture(await manager.observe('extract', 'browser.page.read', { chunkSize: 12_000, start: 0 }));
    if (!new RegExp(`Saved Mimi-${iteration}`).test(JSON.stringify(page))) throw new Error('post-submit extract did not contain the saved value');
    capture(await manager.act('click', 'browser.element.write', {
      role: 'link', name: 'Open secondary',
    }));
    const clickedTabs = capture(await manager.observe('list_tabs', 'browser.tabs.read', {}));
    if (!/secondary/.test(JSON.stringify(clickedTabs))) throw new Error('target=_blank click was not visible in list_tabs');
    const secondaryHeading = capture(await manager.observe('read_element', 'browser.element.read', {
      selector: 'h1',
    }));
    if (!/Secondary tab/.test(JSON.stringify(secondaryHeading))) throw new Error('target=_blank tab was not active');
    capture(await manager.act('close_tab', 'browser.tabs.write', {}));
    capture(await manager.assert({ kind: 'text', value: `Saved Mimi-${iteration}`, timeoutMs: 10_000 }));
    capture(await manager.act('new_tab', 'browser.tabs.write', { url: `${baseUrl}/secondary` }));
    const tabs = capture(await manager.observe('list_tabs', 'browser.tabs.read', {}));
    if (!/secondary/.test(JSON.stringify(tabs))) throw new Error('new tab was not visible in list_tabs');
    capture(await manager.act('close_tab', 'browser.tabs.write', {}));
  } catch (error) {
    failure = errorText(error);
  } finally {
    try {
      capture(await manager.endRun());
    } catch (error) {
      failure ??= `cleanup failed: ${errorText(error)}`;
    }
    try {
      const probe = await client.call('probe_tabs', 'all', {});
      sessionLeak = Number(record(probe.result).sessions) !== 0;
      if (sessionLeak) failure ??= `session leak: ${JSON.stringify(probe.result)}`;
    } catch (error) {
      sessionLeak = true;
      failure ??= `session probe failed: ${errorText(error)}`;
    }
  }
  return {
    iteration,
    success: failure === undefined,
    durationMs: Date.now() - started,
    maxPayloadBytes: Math.max(0, ...payloadSizes),
    sessionLeak,
    ...(failure ? { error: failure } : {}),
  };
}

const fixture = await fixtureServer();
const client = new BrowserConnectorClient();
const results: IterationResult[] = [];
try {
  await client.ready();
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const result = await runIteration(client, fixture.baseUrl, iteration);
    results.push(result);
    process.stderr.write(`[browser-e2e] ${iteration}/${iterations} ${result.success ? 'pass' : 'fail'} ${result.durationMs}ms${result.error ? `: ${result.error}` : ''}\n`);
  }
} finally {
  await client.stop();
  await closeServer(fixture.server);
}

const successes = results.filter((result) => result.success).length;
const report = {
  schemaVersion: 1,
  kind: 'mimi-browser-real-e2e',
  iterations,
  successes,
  successRate: iterations ? successes / iterations : 0,
  medianDurationMs: percentile(results.map((result) => result.durationMs), 0.5),
  p95DurationMs: percentile(results.map((result) => result.durationMs), 0.95),
  p95PayloadBytes: percentile(results.map((result) => result.maxPayloadBytes), 0.95),
  sessionLeaks: results.filter((result) => result.sessionLeak).length,
  results,
};
process.stdout.write(`${JSON.stringify(report)}\n`);
if (successes !== iterations || report.sessionLeaks !== 0 || report.p95PayloadBytes > 16 * 1024) process.exitCode = 1;
