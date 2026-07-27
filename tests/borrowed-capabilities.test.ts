import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext, type MCPServer } from '@openai/agents';
import { FileChangeJournal } from '../src/core/file-change-journal.js';
import { FileSession } from '../src/core/session.js';
import { SkillPreferenceStore } from '../src/extensions/skill-preferences.js';
import { SkillLoader } from '../src/extensions/skills.js';
import { MCPManager } from '../src/extensions/mcp.js';
import { MimiRuntimeHttpServer } from '../src/daemon/runtime-http.js';
import {
  inputText,
  inputWithAttachments,
  parseAttachmentInput,
  stageAttachments,
} from '../src/runtime/attachments.js';
import { diagnoseWrittenFiles } from '../src/runtime/file-diagnostics.js';
import { writeLocalFile } from '../src/tools.js';

test('attachment input is parsed, snapshotted and converted to multimodal model input', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-attachments-'));
  const image = path.join(root, 'photo.png');
  const note = path.join(root, 'note.txt');
  await writeFile(image, Buffer.from([137, 80, 78, 71]));
  await writeFile(note, 'hello');
  const parsed = parseAttachmentInput('分析它 @image:photo.png @file:"note.txt"');
  assert.equal(parsed.text, '分析它');
  const staged = await stageAttachments(parsed.attachments, root, path.join(root, '.staged'));
  assert.equal(staged.length, 2);
  const input = await inputWithAttachments(parsed.text, staged);
  assert.notEqual(typeof input, 'string');
  assert.equal(inputText(input), '分析它');
  assert.deepEqual((input as Array<{ content: Array<{ type: string }> }>)[0]!.content.map((part) => part.type), [
    'input_text', 'input_image', 'input_file',
  ]);
});

test('attachment staging rejects workspace escape and symlink input', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-attachments-safe-'));
  await assert.rejects(
    stageAttachments([{ path: '../outside.txt' }], root, path.join(root, '.staged')),
    /不能超出当前工作区/,
  );
});

test('Session persists attachment placeholders instead of base64 payloads', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-attachment-session-'));
  const session = new FileSession(root, 'attachments');
  await session.addItems([{
    role: 'user',
    content: [
      { type: 'input_text', text: 'inspect' },
      { type: 'input_image', image: 'data:image/png;base64,c2VjcmV0' },
      { type: 'input_file', file: 'data:text/plain;base64,c2VjcmV0', filename: 'note.txt' },
    ],
  }]);
  const raw = await readFile(path.join(root, 'attachments.json'), 'utf8');
  assert.doesNotMatch(raw, /c2VjcmV0/);
  assert.match(raw, /note\.txt/);
});

test('skill preferences persist independent project and user disable scopes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-skill-preferences-'));
  const project = path.join(root, 'project.json');
  const user = path.join(root, 'user.json');
  const store = new SkillPreferenceStore(project, user);
  await store.load();
  await store.set('code-review', 'user', false);
  assert.deepEqual(store.preference('code-review'), { disabled: true, scope: 'user' });
  const reloaded = new SkillPreferenceStore(project, user);
  await reloaded.load();
  assert.deepEqual(reloaded.preference('code-review'), { disabled: true, scope: 'user' });
  await reloaded.set('code-review', 'project', false);
  assert.deepEqual(reloaded.preference('code-review'), { disabled: true, scope: 'project' });
  await reloaded.set('code-review', 'project', true);
  assert.deepEqual(reloaded.preference('code-review'), { disabled: true, scope: 'user' });
});

test('persistent Skill disable participates in the common availability evaluator', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-skill-disabled-'));
  const skillRoot = path.join(root, 'skills', 'review');
  await mkdir(skillRoot, { recursive: true });
  await writeFile(path.join(skillRoot, 'SKILL.md'), [
    '---',
    'name: review',
    'description: Review code',
    '---',
    'Review the code.',
  ].join('\n'));
  const preferences = new SkillPreferenceStore(
    path.join(root, 'project.json'),
    path.join(root, 'user.json'),
  );
  const loader = new SkillLoader(path.join(root, 'skills'), preferences);
  await loader.load();
  await loader.setEnabled('review', 'project', false);
  const skill = loader.get('review')!;
  assert.deepEqual(loader.evaluateAvailability(skill, { canReadLocal: true }).reasons, ['disabled-by-project']);
  assert.throws(() => loader.activate('review'), /当前项目停用/);
});

test('file change journal restores a run and refuses undo after later edits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-file-journal-'));
  const changes = path.join(root, '.changes');
  const file = path.join(root, 'note.txt');
  await writeFile(file, 'before');
  let runId: string | undefined = 'run-1';
  const journal = new FileChangeJournal(changes, root, () => runId);
  await writeLocalFile(root, 'note.txt', 'after', undefined, journal);
  assert.equal((await journal.preview('run-1')).safe, true);
  runId = undefined;
  await journal.undo('run-1');
  assert.equal(await readFile(file, 'utf8'), 'before');

  runId = 'run-2';
  await writeLocalFile(root, 'note.txt', 'second', undefined, journal);
  runId = undefined;
  await writeFile(file, 'later');
  await assert.rejects(journal.undo('run-2'), /又被修改/);
});

test('post-write diagnostics report malformed JSON', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-diagnostics-'));
  const file = path.join(root, 'broken.json');
  await writeFile(file, '{"missing":');
  const report = await diagnoseWrittenFiles(root, [file]);
  assert.equal(report.status, 'issues');
  assert.match(report.output ?? '', /broken\.json/);
});

test('runtime HTTP adapter authenticates, submits and streams terminal events', async () => {
  const token = 'x'.repeat(32);
  const server = new MimiRuntimeHttpServer(0, token, {
    createSession: () => 'session-1',
    submit: async () => ({ taskId: 'task-1', inserted: true }),
    task: () => ({ id: 'task-1', status: 'completed' }),
    cancel: () => ({ state: 'already_terminal' }),
    events: (_taskId, after) => ({
      events: after ? [] : [{ sequence: 1, kind: 'answer', text: 'done' }],
      next: 1,
      terminal: true,
      task: { id: 'task-1', status: 'completed' },
    }),
  });
  await server.start();
  try {
    const unauthorized = await fetch(`${server.address}/v1/sessions`, { method: 'POST' });
    assert.equal(unauthorized.status, 401);
    const created = await fetch(`${server.address}/v1/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.deepEqual(await created.json(), { id: 'session-1' });
    const submitted = await fetch(`${server.address}/v1/sessions/session-1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hello' }),
    });
    assert.equal(submitted.status, 202);
    assert.deepEqual(await submitted.json(), { taskId: 'task-1', inserted: true });
    const events = await fetch(`${server.address}/v1/tasks/task-1/events`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.match(await events.text(), /event: done/);
  } finally {
    await server.close();
  }
});

test('MCP prompt tools reuse the connected SDK client session', async () => {
  const manager = new MCPManager('/missing', process.cwd());
  const fake = {
    name: 'prompt-server',
    cacheToolsList: true,
    underlying: {
      session: {
        listPrompts: async () => ({
          prompts: [{ name: 'review', arguments: [{ name: 'path', required: true }] }],
        }),
        getPrompt: async ({ name, arguments: args }: { name: string; arguments?: Record<string, string> }) => ({
          description: 'Review code',
          messages: [{ role: 'user', content: { type: 'text', text: `${name}:${args?.path}` } }],
        }),
      },
    },
    connect: async () => undefined,
    close: async () => undefined,
    listTools: async () => [],
    callTool: async () => [],
    invalidateToolsCache: async () => undefined,
  } as unknown as MCPServer;
  manager.servers.push(fake);
  const tools = manager.createTools();
  const invoke = async (name: string, input: object) => {
    const selected = tools.find((candidate) => candidate.name === name);
    if (!selected || !('invoke' in selected)) throw new Error(`missing tool ${name}`);
    return selected.invoke(new RunContext({}), JSON.stringify(input));
  };
  assert.match(JSON.stringify(await invoke('list_mcp_prompts', { server: 'prompt-server' })), /review/);
  const prompt = JSON.stringify(await invoke('get_mcp_prompt', {
    server: 'prompt-server',
    name: 'review',
    arguments: { path: 'src' },
  }));
  assert.match(prompt, /review:src/);
  assert.match(prompt, /untrusted-context/);
});
