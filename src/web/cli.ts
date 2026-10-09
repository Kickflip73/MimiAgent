import type { AppConfig } from '../config.js';
import { daemonWebBackend } from './backend.js';
import { MimiWebServer } from './server.js';

export async function runWebCommand(config: AppConfig, args: string[]): Promise<void> {
  if (args.length && (args.length !== 2 || args[0] !== '--port' || !/^\d+$/.test(args[1]!))) {
    throw new Error('用法：mimi web [--port 3210]');
  }
  const server = new MimiWebServer(daemonWebBackend(config), args[1] ? Number(args[1]) : 3210);
  await server.start();
  console.log(`Mimi Web\n${server.launchUrl}\n\n仅本机可访问。请保留此终端；Ctrl+C 关闭 Web，后台任务继续运行。`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void server.close().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
