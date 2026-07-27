import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

const MAX_BODY_BYTES = 1_000_000;

export interface RuntimeHttpHandlers {
  createSession(): string;
  submit(sessionId: string, input: string, idempotencyKey?: string): Promise<{ taskId: string; inserted: boolean }>;
  task(taskId: string): unknown;
  cancel(taskId: string, reason?: string): Promise<unknown> | unknown;
  events(taskId: string, after: number): {
    events: unknown[];
    next: number;
    terminal: boolean;
    task: unknown;
  };
}

function secureEqual(left: string, right: string): boolean {
  const a = createHash('sha256').update(left).digest();
  const b = createHash('sha256').update(right).digest();
  return timingSafeEqual(a, b);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_BODY_BYTES) throw new Error('请求正文超过 1MB');
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求正文必须是 JSON 对象');
  return value as Record<string, unknown>;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

export class MimiRuntimeHttpServer {
  private server?: Server;

  constructor(
    private readonly port: number,
    private readonly token: string,
    private readonly handlers: RuntimeHttpHandlers,
  ) {
    if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
      throw new Error('MIMI_RUNTIME_HTTP_PORT 必须在 1～65535 之间');
    }
    if (Buffer.byteLength(token, 'utf8') < 32) throw new Error('MIMI_RUNTIME_HTTP_TOKEN 至少需要 32 字节');
  }

  get address(): string | undefined {
    const address = this.server?.address();
    return address && typeof address === 'object' ? `http://127.0.0.1:${address.port}` : undefined;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((request, response) => {
      void this.route(request, response).catch((error) => {
        if (!response.headersSent) json(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
        else response.end();
      });
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ') || !secureEqual(authorization.slice(7), this.token)) {
      json(response, 401, { error: 'unauthorized' });
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'POST' && url.pathname === '/v1/sessions') {
      json(response, 201, { id: this.handlers.createSession() });
      return;
    }
    const message = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/messages$/);
    if (request.method === 'POST' && message) {
      const body = await readJson(request);
      if (typeof body.input !== 'string' || !body.input.trim()) throw new Error('input 必须是非空字符串');
      const headerKey = request.headers['idempotency-key'];
      const result = await this.handlers.submit(
        decodeURIComponent(message[1]!),
        body.input,
        typeof body.idempotencyKey === 'string'
          ? body.idempotencyKey
          : typeof headerKey === 'string' ? headerKey : undefined,
      );
      json(response, result.inserted ? 202 : 200, result);
      return;
    }
    const task = url.pathname.match(/^\/v1\/tasks\/([^/]+)$/);
    if (request.method === 'GET' && task) {
      json(response, 200, this.handlers.task(decodeURIComponent(task[1]!)));
      return;
    }
    const cancel = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/cancel$/);
    if (request.method === 'POST' && cancel) {
      const body = await readJson(request);
      json(response, 200, await this.handlers.cancel(
        decodeURIComponent(cancel[1]!),
        typeof body.reason === 'string' ? body.reason : undefined,
      ));
      return;
    }
    const events = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/events$/);
    if (request.method === 'GET' && events) {
      const taskId = decodeURIComponent(events[1]!);
      let after = Number(url.searchParams.get('after') ?? request.headers['last-event-id'] ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) after = 0;
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      const deadline = Date.now() + 30_000;
      while (!response.destroyed && Date.now() < deadline) {
        const page = this.handlers.events(taskId, after);
        for (const event of page.events) {
          const value = event && typeof event === 'object' ? event as Record<string, unknown> : {};
          const sequence = typeof value.sequence === 'number' ? value.sequence : page.next;
          response.write(`id: ${sequence}\nevent: update\ndata: ${JSON.stringify(event)}\n\n`);
        }
        after = page.next;
        if (page.terminal) {
          response.write(`event: done\ndata: ${JSON.stringify(page.task)}\n\n`);
          response.end();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      response.write(`event: heartbeat\ndata: {}\n\n`);
      response.end();
      return;
    }
    json(response, 404, { error: 'not_found' });
  }
}

export function runtimeHttpSessionId(): string {
  return `mimi-http-${randomUUID()}`;
}
