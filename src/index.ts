#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { loadConfig, loadEnvironment } from './config.js';
import { daemonHelp, runDaemonCommand } from './daemon/cli.js';
import {
  parseProviderSetRequest,
  persistProviderConfiguration,
} from './provider-config.js';

async function version(): Promise<string> {
  const file = new URL('../package.json', import.meta.url);
  const manifest = JSON.parse(await readFile(file, 'utf8')) as { version: string };
  return manifest.version;
}

function cliHelp(): string {
  return `MimiAgent - 全天候个人 Agent

用法：
  mimi                    开始对话
  mimi "任务"             执行单次任务
  mimi provider set ...    原子配置模型 Provider 并重启
  mimi --help             查看帮助
  mimi --version          查看版本

后台服务会自动启动，并与 CLI 共享同一个 Agent、Session 和工具能力，无需单独启动。

维护与诊断：mimi daemon --help`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === 'daemon' && args.slice(1).some((arg) => arg === '--help' || arg === '-h' || arg === 'help')) {
    console.log(daemonHelp());
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log(cliHelp());
    return;
  }
  if (args.includes('--version') || args.includes('-v')) {
    console.log(await version());
    return;
  }
  loadEnvironment();
  if (args[0] === 'provider') {
    const request = parseProviderSetRequest(args.slice(1));
    const persisted = await persistProviderConfiguration(request);
    const config = loadConfig();
    if (!request.restart) {
      console.log(`Provider 配置已保存到 ${persisted.environmentFile}，未重启后台服务。`);
      return;
    }
    const { restartMimiDaemon } = await import('./daemon/service.js');
    let status;
    try {
      status = await restartMimiDaemon(config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Provider 配置已保存到 ${persisted.environmentFile}，但当前 MimiAgent 后台尚未切换：${message}`,
      );
    }
    console.log(
      `Provider 已切换为 ${persisted.provider}${persisted.model ? `/${persisted.model}` : ''}`
      + `，MimiAgent 后台已重启（PID ${status.pid}）。`,
    );
    return;
  }
  const config = loadConfig();
  if (args[0] === 'daemon') {
    await runDaemonCommand(config, args.slice(1));
    return;
  }
  const { runMimiCli } = await import('./chat-terminal.js');
  await runMimiCli(config, args, await version());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
