import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CommandHandler, type CommandTarget } from '../src/commands.js';
import { MimiChatClient, RemoteCommandTarget } from '../src/daemon/chat-client.js';
import { MIMI_BUILD_VERSION } from '../src/daemon/client-runtime.js';
import { MimiIpcServer } from '../src/daemon/ipc.js';
import { DAEMON_PROTOCOL_VERSION, type DaemonStatus } from '../src/daemon/types.js';
import type { AppConfig } from '../src/config.js';

test('CLI adopts a running daemon workspace even when local workspace is explicitly configured', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-workspace-adopt-'));
  const localWorkspace = path.join(root, 'local');
  const daemonWorkspace = path.join(root, 'daemon-workspace');
  const socket = path.join(root, 'mimi.sock');
  const status = {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    buildVersion: MIMI_BUILD_VERSION,
    permissionMode: 'trusted',
    workspaceRoot: daemonWorkspace,
  } as DaemonStatus;
  const server = new MimiIpcServer(socket, (method) => {
    if (method === 'status') return status;
    throw new Error(`unexpected method: ${method}`);
  });
  await server.start();
  try {
    const config = {
      dataRoot: path.join(localWorkspace, '.mimi-agent'),
      daemonDataRoot: root,
      workspaceRoot: localWorkspace,
      skillsRoot: path.join(localWorkspace, 'skills'),
      mcpConfig: path.join(localWorkspace, 'mcp.json'),
      provider: 'openai',
      permissionMode: 'trusted',
    } as AppConfig;
    let reconciledWorkspace: string | undefined;
    const client = new MimiChatClient(config, async (daemonConfig) => {
      reconciledWorkspace = daemonConfig.workspaceRoot;
      return status;
    });

    assert.equal((await client.connect()).workspaceRoot, daemonWorkspace);
    assert.equal(reconciledWorkspace, daemonWorkspace);
  } finally {
    await server.close();
  }
});

test('CLI re-adopts the workspace when the daemon is replaced', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-workspace-replaced-'));
  const socket = path.join(root, 'mimi.sock');
  const initialWorkspace = path.join(root, 'initial');
  const replacementWorkspace = path.join(root, 'replacement');
  const status = {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    buildVersion: MIMI_BUILD_VERSION,
    permissionMode: 'trusted',
    workspaceRoot: initialWorkspace,
  } as DaemonStatus;
  const server = new MimiIpcServer(socket, (method) => {
    if (method === 'status') return status;
    if (method === 'chat.snapshot') return {
      sessionId: 'existing', draft: false, workspaceRoot: replacementWorkspace,
      provider: 'openai', model: 'fixture', mode: '通用', outputLevel: 'tools',
      contextUsed: 0, contextWindow: 10_000, items: [], plan: [],
    };
    throw new Error(`unexpected method: ${method}`);
  });
  await server.start();
  try {
    const config = {
      dataRoot: root, daemonDataRoot: root, workspaceRoot: initialWorkspace,
      provider: 'openai', permissionMode: 'trusted',
    } as AppConfig;
    const client = new MimiChatClient(config, async () => status);

    await client.connect();
    assert.equal((await client.snapshot()).workspaceRoot, replacementWorkspace);
  } finally {
    await server.close();
  }
});

test('a draft bootstrap adopts the replacement daemon workspace shown in the banner', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-draft-workspace-replaced-'));
  const socket = path.join(root, 'mimi.sock');
  const initialWorkspace = path.join(root, 'initial');
  const replacementWorkspace = path.join(root, 'replacement');
  let status = {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    buildVersion: MIMI_BUILD_VERSION,
    permissionMode: 'trusted',
    workspaceRoot: initialWorkspace,
  } as DaemonStatus;
  const server = new MimiIpcServer(socket, (method, params) => {
    if (method === 'status') return status;
    if (method === 'chat.bootstrap') return {
      sessionId: (params as { draftSessionId: string }).draftSessionId,
      draft: true, workspaceRoot: replacementWorkspace,
      provider: 'openai', model: 'fixture', mode: '通用', outputLevel: 'tools',
      contextUsed: 0, contextWindow: 10_000, items: [], plan: [],
    };
    throw new Error(`unexpected method: ${method}`);
  });
  await server.start();
  try {
    const config = {
      dataRoot: root, daemonDataRoot: root, workspaceRoot: initialWorkspace,
      provider: 'openai', permissionMode: 'trusted',
    } as AppConfig;
    let reconciledWorkspace: string | undefined;
    const client = new MimiChatClient(config, async (daemonConfig) => {
      reconciledWorkspace = daemonConfig.workspaceRoot;
      return status;
    });

    await client.connect();
    status = { ...status, workspaceRoot: replacementWorkspace };
    assert.equal((await client.bootstrap('replacement-draft')).workspaceRoot, replacementWorkspace);
    assert.equal((await client.connect()).workspaceRoot, replacementWorkspace);
    assert.equal(reconciledWorkspace, replacementWorkspace);
  } finally {
    await server.close();
  }
});

test('CLI restarts an unavailable daemon and retries a draft bootstrap', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-bootstrap-reconnect-'));
  const socket = path.join(root, 'mimi.sock');
  const workspaceRoot = path.join(root, 'workspace');
  const status = {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    buildVersion: MIMI_BUILD_VERSION,
    permissionMode: 'trusted',
    workspaceRoot,
  } as DaemonStatus;
  const server = new MimiIpcServer(socket, (method, params) => {
    if (method === 'status') return status;
    if (method === 'chat.bootstrap') return {
      sessionId: (params as { draftSessionId: string }).draftSessionId,
      draft: true, workspaceRoot, provider: 'openai', model: 'fixture', mode: '通用',
      outputLevel: 'tools', contextUsed: 0, contextWindow: 10_000, items: [], plan: [],
    };
    throw new Error(`unexpected method: ${method}`);
  });
  const config = {
    dataRoot: root, daemonDataRoot: root, workspaceRoot,
    provider: 'openai', permissionMode: 'trusted',
  } as AppConfig;
  let starts = 0;
  const client = new MimiChatClient(config, async () => status, {
    startDaemon: async () => {
      starts += 1;
      await server.start();
      return status;
    },
  });
  try {
    assert.equal((await client.bootstrap('reconnected-draft')).sessionId, 'reconnected-draft');
    assert.equal(starts, 1);
  } finally {
    await server.close();
  }
});

test('CLI submits its launch workspace with each owner command', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-submit-workspace-'));
  const socket = path.join(root, 'mimi.sock');
  const workspaceRoot = path.join(root, 'project');
  let submitted: Record<string, unknown> | undefined;
  const server = new MimiIpcServer(socket, (method, params) => {
    if (method !== 'submit') throw new Error(`unexpected method: ${method}`);
    submitted = params as Record<string, unknown>;
    return {
      event: { id: 'event' },
      task: { id: 'task' },
      inserted: true,
    };
  });
  await server.start();
  try {
    const client = new MimiChatClient({
      dataRoot: root,
      daemonDataRoot: root,
      workspaceRoot,
      provider: 'openai',
      permissionMode: 'trusted',
    } as AppConfig);
    await client.submit('修复当前项目');
    assert.equal(submitted?.workspaceRoot, workspaceRoot);
    assert.equal(submitted?.source, 'local-cli');
    assert.equal(submitted?.trust, 'owner');
  } finally {
    await server.close();
  }
});

test('a new command prepares an in-memory draft instead of switching a real Session', async () => {
  const calls: string[] = [];
  const target = {
    currentSessionId: 'existing',
    sessionReady: true,
    prepareNewSession: async () => { calls.push('prepare'); },
    switchSession: async () => { calls.push('switch'); },
  } as unknown as CommandTarget;
  const handler = new CommandHandler(target, async () => undefined, {
    resetScreen: async () => { calls.push('reset'); },
    write: () => undefined,
  });

  assert.equal(await handler.execute('/new'), 'handled');
  assert.deepEqual(calls, ['prepare', 'reset']);
});

test('a draft can list and select an existing Session without materializing itself', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-session-draft-'));
  const socket = path.join(root, 'mimi.sock');
  const methods: string[] = [];
  const server = new MimiIpcServer(socket, (method, params) => {
    methods.push(method);
    if (method === 'chat.bootstrap') return {
      sessionId: (params as { draftSessionId: string }).draftSessionId,
      draft: true,
      workspaceRoot: root,
      provider: 'openai', model: 'fixture', mode: '通用', outputLevel: 'tools',
      contextUsed: 0, contextWindow: 10_000, items: [], plan: [],
    };
    if (method === 'chat.sessions') return [{
      id: 'existing', title: 'MimiAgent 会话管理', preview: '继续讨论',
      updatedAt: new Date(0).toISOString(), turns: 2, recoverable: false,
    }];
    if (method === 'chat.invoke') return { sessionId: 'existing' };
    throw new Error(`unexpected method: ${method}`);
  });
  await server.start();
  try {
    const config = {
      dataRoot: root,
      daemonDataRoot: root,
      workspaceRoot: root,
      provider: 'openai',
      permissionMode: 'trusted',
    } as AppConfig;
    const client = new MimiChatClient(config);
    const draft = await client.bootstrap('mimi-chat-draft');
    const target = new RemoteCommandTarget(client, draft.sessionId, false);

    assert.equal(target.sessionReady, false);
    assert.equal((await target.listSessionSummaries())[0]?.id, 'existing');
    assert.equal(target.sessionReady, false);
    await target.switchSession('existing');
    assert.equal(target.currentSessionId, 'existing');
    assert.equal(target.sessionReady, true);
    assert.deepEqual(methods, ['chat.bootstrap', 'chat.sessions', 'chat.sessions', 'chat.invoke']);
  } finally {
    await server.close();
  }
});

test('a security selection is sent to the draft Session and materializes it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-security-draft-'));
  const socket = path.join(root, 'mimi.sock');
  let invocation: Record<string, unknown> | undefined;
  const server = new MimiIpcServer(socket, (method, params) => {
    if (method === 'chat.invoke') {
      invocation = params as Record<string, unknown>;
      return { updated: true };
    }
    throw new Error(`unexpected method: ${method}`);
  });
  await server.start();
  try {
    const client = new MimiChatClient({
      dataRoot: root,
      daemonDataRoot: root,
      workspaceRoot: root,
      provider: 'openai',
      permissionMode: 'read-only',
    } as AppConfig);
    const target = new RemoteCommandTarget(client, 'mimi-chat-security-draft', false);

    await target.switchSecurityProfile('workstation');

    assert.equal(target.sessionReady, true);
    assert.equal(invocation?.operation, 'security.set');
    assert.equal(invocation?.value, 'workstation');
    assert.equal(invocation?.sessionKey, 'mimi-chat-security-draft');
  } finally {
    await server.close();
  }
});

test('a model selection is sent to a draft without marking its first message as sent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-model-draft-'));
  const socket = path.join(root, 'mimi.sock');
  let invocation: Record<string, unknown> | undefined;
  const server = new MimiIpcServer(socket, (method, params) => {
    if (method === 'chat.invoke') {
      invocation = params as Record<string, unknown>;
      return { updated: true };
    }
    throw new Error(`unexpected method: ${method}`);
  });
  await server.start();
  try {
    const client = new MimiChatClient({
      dataRoot: root,
      daemonDataRoot: root,
      workspaceRoot: root,
      provider: 'openai',
      permissionMode: 'read-only',
    } as AppConfig);
    const target = new RemoteCommandTarget(client, 'mimi-chat-model-draft', false);

    await target.switchModel('gpt-5-mini');

    assert.equal(target.sessionReady, false);
    assert.equal(invocation?.operation, 'model.set');
    assert.equal(invocation?.value, 'gpt-5-mini');
    assert.equal(invocation?.sessionKey, 'mimi-chat-model-draft');
  } finally {
    await server.close();
  }
});

test('structured model control is sent through the Session-scoped Daemon operation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-model-control-ipc-'));
  const socket = path.join(root, 'mimi.sock');
  let invocation: Record<string, unknown> | undefined;
  const server = new MimiIpcServer(socket, (method, params) => {
    if (method === 'chat.invoke') {
      invocation = params as Record<string, unknown>;
      return { effective: 'next_run', daemonRestarted: false };
    }
    throw new Error(`unexpected method: ${method}`);
  });
  await server.start();
  try {
    const client = new MimiChatClient({
      dataRoot: root,
      daemonDataRoot: root,
      workspaceRoot: root,
      provider: 'openai',
      permissionMode: 'read-only',
    } as AppConfig);
    const target = new RemoteCommandTarget(client, 'mimi-chat-model-control', true);
    const request = {
      action: 'use' as const,
      target: { providerId: 'right', modelId: 'right-model' },
    };

    assert.deepEqual(await target.modelControl(request), {
      effective: 'next_run',
      daemonRestarted: false,
    });
    assert.equal(invocation?.operation, 'model.control');
    assert.deepEqual(invocation?.value, request);
    assert.equal(invocation?.sessionKey, 'mimi-chat-model-control');
  } finally {
    await server.close();
  }
});

test('commands are not centrally blocked while the Session is still a draft', async () => {
  const output: string[] = [];
  let runtimeRequests = 0;
  const target = {
    currentSessionId: 'mimi-chat-draft',
    sessionReady: false,
    runtimeInfo: async () => {
      runtimeRequests += 1;
      return {
        provider: 'openai',
        model: 'gpt-5.4-mini',
        mode: { id: 'general', label: '通用' },
        sessionId: 'mimi-chat-draft',
        workspaceRoot: '/tmp/draft',
        permissionMode: 'read-only',
        skillCount: 0,
        memoryCount: 0,
        mcpServers: [],
        guidanceFiles: [],
        team: { total: 0, running: 0, completed: 0 },
      };
    },
  } as unknown as CommandTarget;
  const handler = new CommandHandler(target, async () => undefined, {
    write: (message) => { output.push(message); },
  });

  assert.equal(await handler.execute('/status'), 'handled');
  assert.equal(runtimeRequests, 1);
  assert.match(output[0] ?? '', /gpt-5\.4-mini/);
  assert.doesNotMatch(output[0] ?? '', /发送第一条消息后才会创建 Session/);
});
