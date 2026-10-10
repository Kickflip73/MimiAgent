import { existsSync } from 'node:fs';
import { notificationText, notificationUrl } from './notification-content.js';
import { notificationOrigin } from './web-endpoint.js';
import { spawn } from 'node:child_process';
import type { OutboxMessage } from './types.js';

export interface NotificationSink {
  deliver(message: OutboxMessage): Promise<void>;
}

export class UncertainDeliveryError extends Error {
  override readonly name = 'UncertainDeliveryError';
}

export class PermanentDeliveryError extends Error {
  override readonly name = 'PermanentDeliveryError';
}

export function isUncertainDeliveryError(error: unknown): error is UncertainDeliveryError {
  return error instanceof UncertainDeliveryError;
}

export function isPermanentDeliveryError(error: unknown): error is PermanentDeliveryError {
  return error instanceof PermanentDeliveryError;
}

const SYSTEM_NOTIFICATION_TIMEOUT_MS = 10_000;

export async function runNotificationCommand(
  command: string,
  args: string[],
  timeoutMs = SYSTEM_NOTIFICATION_TIMEOUT_MS,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const settle = (operation: () => void) => {
      clearTimeout(timer);
      operation();
    };
    child.once('error', (error) => settle(() => reject(error)));
    child.once('exit', (code) => settle(() => {
      if (timedOut) reject(new UncertainDeliveryError(`${command} 通知命令执行超时`));
      else if (code === 0) resolve();
      else if (code === 3) reject(new PermanentDeliveryError('macOS 通知权限未开启；请在系统设置 → 通知中允许 terminal-notifier。完整消息保留在 Mimi 通知中心。'));
      else reject(new UncertainDeliveryError(`${command} 通知未确认送达，退出码 ${code}`));
    }));
  });
}

export function systemNotificationArgs(text: string, id: string, url: string): string[] {
  const compact = text.replace(/\s+/g, ' ').trim();
  const preview = compact.length > 140 ? `${compact.slice(0, 140)}…` : compact;
  // terminal-notifier reads values through NSUserDefaults, which parses leading delimiters.
  const escaped = /^[\[({"]/.test(preview) ? `\\${preview}` : preview;
  return ['-title', 'MimiAgent', '-subtitle', '点击查看完整消息', '-message', escaped || '有一条新消息',
    '-group', `mimi-${id}`, '-open', url];
}

class SystemNotificationSink implements NotificationSink {
  constructor(private readonly root?: string) {}
  async deliver(message: OutboxMessage): Promise<void> {
    const text = notificationText(message.payload);
    if (process.platform === 'darwin') {
      const command = ['/opt/homebrew/bin/terminal-notifier', '/usr/local/bin/terminal-notifier'].find(existsSync);
      if (!command) throw new PermanentDeliveryError('macOS 通知需要 terminal-notifier（brew install terminal-notifier）；完整消息已保留在 Web 通知中心');
      const url = notificationUrl(await notificationOrigin(this.root), message.id);
      await runNotificationCommand(command, systemNotificationArgs(text, message.id, url));
      return;
    }
    process.stdout.write(`[MimiAgent] ${text}\n`);
  }
}

class ConsoleNotificationSink implements NotificationSink {
  async deliver(message: OutboxMessage): Promise<void> {
    process.stdout.write(`[MimiAgent:${message.channel}${message.target ? `:${message.target}` : ''}] ${notificationText(message.payload)}\n`);
  }
}

export class NotifierRegistry {
  private readonly sinks = new Map<string, NotificationSink>();

  constructor(options: { daemonRoot?: string } = {}) {
    this.sinks.set('system', new SystemNotificationSink(options.daemonRoot));
    this.sinks.set('local', new ConsoleNotificationSink());
  }

  register(channel: string, sink: NotificationSink): void {
    this.sinks.set(channel, sink);
  }

  unregister(channel: string, sink: NotificationSink): void {
    if (this.sinks.get(channel) === sink) this.sinks.delete(channel);
  }

  async deliver(message: OutboxMessage): Promise<void> {
    const sink = this.sinks.get(message.channel);
    if (!sink) throw new PermanentDeliveryError(`未配置通知通道：${message.channel}`);
    await sink.deliver(message);
  }
}
