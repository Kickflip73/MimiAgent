import assert from 'node:assert/strict';
import test from 'node:test';
import { runNotificationCommand, systemNotificationArgs } from '../src/daemon/notifier.js';
import { notificationUrl, notificationText } from '../src/daemon/notification-content.js';

test('native notifications open the full durable message with safe structured arguments', () => {
  const url = notificationUrl('http://127.0.0.1:4567/', 'notice-1');
  const args = systemNotificationArgs('[' + '长消息'.repeat(1000), 'notice-1', url);
  assert.equal(args[args.indexOf('-open') + 1], 'http://127.0.0.1:4567/?notification=notice-1');
  assert.equal(args.includes('-execute'), false);
  assert.equal(args[args.indexOf('-group') + 1], 'mimi-notice-1');
  assert.ok(args[args.indexOf('-message') + 1]!.length < 200);
  assert.match(args[args.indexOf('-message') + 1]!, /^\\\[/);
  assert.equal(notificationText({text:'full'.repeat(1000)}).length,4000);
  assert.throws(() => notificationUrl('https://evil.example', 'id'));
  assert.throws(() => notificationUrl('file:///tmp/file', 'id'));
});

test('system notification command is force-terminated after its deadline', async () => {
  await assert.rejects(runNotificationCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 100), /通知命令执行超时/);
});
