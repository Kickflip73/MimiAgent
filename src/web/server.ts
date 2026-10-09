import { imageIds, imageMediaType, IMAGE_MAX_BYTES } from '../core/image-attachment.js';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { modelTargetSchema } from '../core/model-routing.js';
import type { SecurityProfile } from '../config.js';
import type { WebBackend } from './backend.js';

const ASSETS: Record<string, [string, string]> = {
  '/images.js': ['images.js', 'text/javascript; charset=utf-8'],
  '/queue.js': ['queue.js', 'text/javascript; charset=utf-8'],
  '/context.js': ['context.js', 'text/javascript; charset=utf-8'],
  '/execution.js': ['execution.js', 'text/javascript; charset=utf-8'],
  '/manage.js': ['manage.js', 'text/javascript; charset=utf-8'],
  '/pickers.js': ['pickers.js', 'text/javascript; charset=utf-8'],
  '/cat.svg': ['cat.svg', 'image/svg+xml'],
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'paused', 'blocked', 'dead_letter']);

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value ?? null));
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    throw new HttpError(415, '需要 application/json');
  }
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 256_000) throw new HttpError(413, '内容过长，请缩短消息。');
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new HttpError(400, '无效的 JSON 请求'); }
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new HttpError(400, '无效的记录 ID');
  return value;
}

/** Direct local UI; loopback binding and same-origin checks bound browser access. */
export class MimiWebServer {
  private server?: Server;
  private streams = 0;

  constructor(private readonly backend: WebBackend, private readonly port = 3210) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Web 端口无效');
  }

  get address(): string {
    const address = this.server?.address();
    if (!address || typeof address === 'string') throw new Error('Web 尚未启动');
    return `http://127.0.0.1:${address.port}`;
  }

  get launchUrl(): string { return `${this.address}/`; }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((request, response) => {
      response.setHeader('cache-control', 'no-store');
      response.setHeader('x-content-type-options', 'nosniff');
      response.setHeader('referrer-policy', 'no-referrer');
      response.setHeader('x-frame-options', 'DENY');
      response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      void this.route(request, response).catch((error: unknown) => {
        if (response.destroyed) return;
        if (response.headersSent) { response.end(); return; }
        json(response, error instanceof HttpError ? error.status : 503, {
          error: error instanceof Error ? error.message : '后台服务暂时不可用',
        });
      });
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    this.server = server;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    this.server = undefined;
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const origin = this.address;
    if (request.headers.host !== new URL(origin).host) throw new HttpError(403, '无效的访问地址');
    const site = request.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, '禁止跨站访问');
    if (request.headers.origin && request.headers.origin !== origin) throw new HttpError(403, '禁止跨站访问');
    const url = new URL(request.url ?? '/', origin);
    if (request.method === 'GET' && ASSETS[url.pathname]) {
      const [file, type] = ASSETS[url.pathname]!;
      const content = await readFile(new URL(`./assets/${file}`, import.meta.url));
      response.writeHead(200, { 'content-type': type });
      response.end(content);
      return;
    }
    if (request.method === 'POST') {
      if (request.headers.origin !== origin || request.headers['x-mimi-web'] !== '1') {
        throw new HttpError(403, '请求来源未通过验证');
      }
    }
    const get = request.method === 'GET';
    if (get && url.pathname === '/api/manage') {
      if (!this.backend.manageRead) throw new HttpError(503, '管理接口不可用');
      json(response, 200, await this.backend.manageRead(identifier(url.searchParams.get('area')), identifier(url.searchParams.get('session')))); return;
    }
    if (request.method === 'POST' && url.pathname === '/api/manage') {
      if (!this.backend.manageWrite) throw new HttpError(503, '管理接口不可用');
      const input = await body(request);
      json(response, 200, await this.backend.manageWrite(identifier(input.action), identifier(input.sessionId), input.value)); return;
    }
    if (url.pathname === '/api/images') {
      if (get && this.backend.image) {
        const id=String(url.searchParams.get('id')||'');
        try {imageMediaType(id);}catch{throw new HttpError(400,'无效的图片标识');}
        let image;
        try {image=await this.backend.image(id);}catch(error){if((error as {status?:number}).status===404)throw new HttpError(404,'图片已不存在');throw error;}
        response.writeHead(200, {'content-type':image.mediaType,'cache-control':'private, max-age=86400','x-content-type-options':'nosniff'});
        response.end(image.data); return;
      }
      if (request.method === 'POST' && this.backend.uploadImage) {
        const chunks:Buffer[]=[]; let size=0;
        for await (const chunk of request) {
          size+=chunk.length;
          if(size>IMAGE_MAX_BYTES) throw new HttpError(413,'图片不能超过 10MB');
          chunks.push(Buffer.from(chunk));
        }
        try { json(response,201,await this.backend.uploadImage(Buffer.concat(chunks),String(request.headers['content-type']||'').split(';')[0]!)); }
        catch(error) { throw new HttpError(400,error instanceof Error ? error.message : '图片上传失败'); }
        return;
      }
      throw new HttpError(503,'图片接口不可用');
    }
    if (get && url.pathname === '/api/status') { json(response, 200, await this.backend.status()); return; }
    if (get && url.pathname === '/api/sessions') { json(response, 200, await this.backend.sessions()); return; }
    if (get && url.pathname === '/api/session') {
      json(response, 200, await this.backend.session(identifier(url.searchParams.get('id')), url.searchParams.get('draft') === '1')); return;
    }
    if (get && url.pathname === '/api/history') { json(response, 200, await this.backend.history(identifier(url.searchParams.get('id')))); return; }
    if (get && url.pathname === '/api/context') { json(response, 200, await this.backend.context(identifier(url.searchParams.get('session')))); return; }
    if (get && url.pathname === '/api/models') { json(response, 200, await this.backend.models(identifier(url.searchParams.get('session')))); return; }
    if (get && url.pathname === '/api/progress') {
      const after = Number(url.searchParams.get('after') ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, '无效的事件游标');
      const page = await this.backend.stream(identifier(url.searchParams.get('id')), after);
      if (!page.task) throw new HttpError(404, '任务记录已不存在');
      json(response, 200, page); return;
    }
    if (get && url.pathname === '/api/run') {
      const snapshot = await this.backend.stream(identifier(url.searchParams.get('id')), 0);
      if (!snapshot.task) throw new HttpError(404, '任务记录已不存在');
      json(response, 200, snapshot.task); return;
    }
    if (get && url.pathname === '/api/tasks') { json(response, 200, await this.backend.tasks()); return; }
    if (get && url.pathname === '/api/task') { json(response, 200, await this.backend.task(identifier(url.searchParams.get('id')))); return; }
    if (get && url.pathname === '/api/memory') { json(response, 200, await this.backend.memory(identifier(url.searchParams.get('session')))); return; }
    if (get && url.pathname === '/api/memory/read') {
      const scope = url.searchParams.get('scope');
      if (scope !== 'private' && scope !== 'workspace') throw new HttpError(400, '无效的记忆范围');
      json(response, 200, await this.backend.memoryRead(identifier(url.searchParams.get('session')), scope, identifier(url.searchParams.get('id')))); return;
    }
    if (get && url.pathname === '/api/events') {
      const id = identifier(url.searchParams.get('id'));
      const after = Number(request.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, '无效的事件游标');
      if (this.streams >= 16) throw new HttpError(429, '连接过多，请关闭多余页面');
      await this.stream(id, after, response); return;
    }
    if (request.method === 'POST' && url.pathname === '/api/messages') {
      const input = await body(request);
      const id = identifier(input.sessionId);
      let images:string[];
      try { images=imageIds(input.images); } catch(error) {throw new HttpError(400,(error as Error).message);}
      if (typeof input.input !== 'string' || (!input.input.trim() && !images.length) || input.input.length > 60_000) throw new HttpError(400, '消息不能为空或超过 60000 字');
      if (typeof input.requestId !== 'string' || !UUID.test(input.requestId)) throw new HttpError(400, '无效的请求 ID');
      if (input.security !== undefined && !['safe', 'workstation', 'full-owner'].includes(String(input.security))) throw new HttpError(400, '无效的安全等级');
      if(input.workspaceRoot!==undefined && (typeof input.workspaceRoot!=='string' || input.workspaceRoot.length>4096))throw new HttpError(400,'无效的工作区');
      const security = input.security as SecurityProfile | undefined;
      const result = images.length ? await this.backend.submit(id,input.input,input.requestId,security,input.workspaceRoot as string | undefined,images)
        : input.workspaceRoot === undefined ? await this.backend.submit(id,input.input,input.requestId,security)
        : await this.backend.submit(id,input.input,input.requestId,security,input.workspaceRoot as string);
      json(response,202,result); return;
    }
    if (request.method === 'POST' && url.pathname === '/api/tasks/action') {
      const input = await body(request);
      if (!['pause', 'resume', 'cancel'].includes(String(input.action))) throw new HttpError(400, '无效的任务操作');
      if (input.context !== undefined && (typeof input.context !== 'string' || input.context.length > 20_000)) throw new HttpError(400, '补充内容过长');
      json(response, 200, await this.backend.taskAction(identifier(input.id), input.action as 'pause' | 'resume' | 'cancel', input.context as string | undefined)); return;
    }
    if (request.method === 'POST' && url.pathname === '/api/model') {
      const input = await body(request);
      const target = input.target === null ? null : modelTargetSchema.safeParse(input.target);
      if (target && !target.success) throw new HttpError(400, '无效的模型');
      json(response, 200, await this.backend.model(identifier(input.sessionId), target?.data ?? null)); return;
    }
    if (request.method === 'POST' && url.pathname === '/api/mode') {
      const input = await body(request);
      if (!['general', 'plan', 'ultra'].includes(String(input.mode))) throw new HttpError(400, '无效的模式');
      json(response, 200, await this.backend.mode(identifier(input.sessionId), input.mode as 'general' | 'plan' | 'ultra')); return;
    }
    throw new HttpError(404, '接口不存在');
  }

  private async stream(id: string, initial: number, response: ServerResponse): Promise<void> {
    this.streams += 1;
    const abort = new AbortController();
    response.once('close', () => abort.abort());
    try {
      let after = initial;
      let page = await this.backend.stream(id, after);
      if (!page.task) throw new HttpError(404, '任务不存在');
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
      response.write('retry: 1500\n\n');
      response.write('event: ready\ndata: {}\n\n');
      let heartbeat = Date.now();
      let quietPolls = 0;
      while (!response.destroyed) {
        if (Date.now() - heartbeat >= 10_000) {
          response.write('event: heartbeat\ndata: {}\n\n');
          heartbeat = Date.now();
        }
        for (const event of page.events) {
          response.write(`id: ${event.sequence}\nevent: update\ndata: ${JSON.stringify(event)}\n\n`);
          after = Math.max(after, event.sequence);
        }
        after = Math.max(after, page.nextSequence ?? after);
        if (!page.hasMore && page.task && TERMINAL.has(page.task.status)) {
          response.write(`event: done\ndata: ${JSON.stringify(page.task)}\n\n`);
          break;
        }
        if (!page.hasMore) {
          quietPolls = page.events.length ? 0 : quietPolls + 1;
          // Fast while producing text, bounded backoff during model/tool silence.
          await delay(Math.min(400, 80 + quietPolls * 40), undefined, { signal: abort.signal });
        }
        if (response.destroyed) break;
        page = await this.backend.stream(id, after);
      }
    } catch (error) {
      if (!response.headersSent) throw error;
      if (!response.destroyed) response.write(`event: unavailable\ndata: ${JSON.stringify({ error: '连接中断，正在重新连接；后台任务继续运行。' })}\n\n`);
    } finally {
      this.streams -= 1;
      if (response.headersSent && !response.destroyed) response.end();
    }
  }
}
