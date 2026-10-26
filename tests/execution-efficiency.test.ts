import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext } from '@openai/agents';
import { tool } from '../src/tool-factory.js';
import { z } from 'zod';
import { searchLocalFiles } from '../src/tools.js';
import { ExecutionLedger } from '../src/core/execution-ledger.js';
import { withExecutionLedger } from '../src/runtime/tool-ledger.js';
import { ToolSetBuilder } from '../src/runtime/pipeline/tool-set-builder.js';

test('filename globs find nested and root files without reading their contents', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-search-'));
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'report.md'), 'root');
  await writeFile(path.join(root, 'docs/report.md'), 'nested');
  for (const glob of ['*.md', '**/*.md']) {
    const matches = await searchLocalFiles(root, 'report', '.', 50, undefined, { globs: [glob], pathsOnly: true, maxReadBytes: 1 });
    assert.deepEqual(matches.map(m => m.path).sort(), ['docs/report.md', 'report.md']);
  }
});

test('explicit new shell calls execute again, SDK replay and durable recovery do not', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-shell-ledger-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  let executions = 0;
  const original = tool({ name: 'run_shell', description: 'fixture', parameters: z.object({command:z.string()}),
    execute: async () => ({ exitCode: 0, stdout: ++executions === 1 ? 'Preparation complete; rerun command' : 'RESULT-42' }) });
  const wrap = () => withExecutionLedger([original], ledger, () => ({sessionId:'s',runId:'event:e',semanticCallIds:true}))[0]!;
  const invoke = async (wrapped: ReturnType<typeof wrap>, id: string) => {
    assert.ok('invoke' in wrapped);
    return wrapped.invoke(new RunContext({}), '{"command":"fixture"}', {toolCall:{callId:id}} as never);
  };
  const wrapped = wrap();
  const first = await invoke(wrapped, 'sdk-1');
  assert.deepEqual(await invoke(wrapped, 'sdk-1'), first);
  assert.match(JSON.stringify(await invoke(wrapped, 'sdk-2')), /RESULT-42/);
  assert.equal(executions, 2);
  const recovered = wrap();
  assert.deepEqual(await invoke(recovered, 'recovered-1'), first);
  assert.match(JSON.stringify(await invoke(recovered, 'recovered-2')), /RESULT-42/);
  assert.equal(executions, 2);
});

test('an uncertain shell is fenced even after a different command or wrapper recovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-shell-uncertain-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  let effects = 0;
  const original = tool({ name:'run_shell', description:'fixture', parameters:z.object({command:z.string()}),
    execute:async ({command}) => { if(command === 'write') { effects++; throw new Error('outcome uncertain'); } return {exitCode:0}; } });
  const wrap = () => withExecutionLedger([original], ledger, () => ({sessionId:'s',runId:'event:e',semanticCallIds:true}))[0]!;
  const invoke = async (wrapped: ReturnType<typeof wrap>, command: string, id: string) => {
    assert.ok('invoke' in wrapped);
    return wrapped.invoke(new RunContext({}), JSON.stringify({command}), {toolCall:{callId:id}} as never);
  };
  const wrapped = wrap();
  assert.match(JSON.stringify(await invoke(wrapped,'write','1')), /tool_failed/);
  await invoke(wrapped,'read','2');
  await assert.rejects(invoke(wrapped,'write','3'));
  await assert.rejects(invoke(wrap(),'write','4'));
  assert.equal(effects,1);
});

test('known Skills can be activated directly without a discovery roundtrip', () => {
  const use = tool({name:'use_skill',description:'fixture',parameters:z.object({name:z.string()}),execute:async()=>''});
  const classified = new ToolSetBuilder().classify([use]);
  assert.deepEqual(classified.direct.map(t=>t.name), ['use_skill']);
});

test('bounded search preserves matches and reports depth, entry and time limits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-search-budget-'));
  await mkdir(path.join(root, 'nested'));
  await writeFile(path.join(root, 'report.md'), 'visible');
  await writeFile(path.join(root, 'nested/report.md'), 'too deep');
  const report = {truncated:false,limitsReached:[] as string[],scannedEntries:0};
  const found = await searchLocalFiles(root, 'report', '.', 50, undefined, {pathsOnly:true,maxDepth:0,report});
  assert.deepEqual(found.map(m=>m.path), ['report.md']);
  assert.deepEqual(report.limitsReached, ['depth']);
  const expired = {truncated:false,limitsReached:[] as string[],scannedEntries:0};
  assert.deepEqual(await searchLocalFiles(root, '', '.', 50, undefined, {pathsOnly:true,timeoutMs:0,report:expired}), []);
  assert.deepEqual(expired.limitsReached, ['time']);
});

test('filename search skips excluded paths, symlinks and dependency trees', async () => {
  const {symlink} = await import('node:fs/promises');
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-search-scope-'));
  for(const dir of ['node_modules','private','docs']) {
    await mkdir(path.join(root,dir)); await writeFile(path.join(root,dir,'note.md'),dir);
  }
  await symlink(path.join(root,'private'),path.join(root,'alias'));
  const found = await searchLocalFiles(root,'note','.',50,undefined,{pathsOnly:true,excludedPaths:[path.join(root,'private')]});
  assert.deepEqual(found.map(m=>m.path),['docs/note.md']);
});

test('shell concurrent claims and nonzero exits cannot be bypassed with a new call id', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-shell-fence-'));
  const ledger = new ExecutionLedger(path.join(root,'ledger.json'));
  const call = (callId: string) => ({sessionId:'s',runId:'r',toolName:'run_shell',callId,argumentsJson:'{"command":"test"}'});
  let release!: () => void;
  const held = new Promise<void>(resolve=>{release=resolve;});
  let began!: () => void;
  const started = new Promise<void>(resolve=>{began=resolve;});
  const first = ledger.executeOnce(call('1'),async()=>{began();await held;return {exitCode:1};});
  await started;
  await assert.rejects(ledger.executeOnce(call('2'),async()=>({exitCode:0})),/不得自动重试/);
  release(); await first;
  await assert.rejects(ledger.executeOnce(call('3'),async()=>({exitCode:0})),/不得自动重试/);
});

test('content search falls back without rg and still finds nested Markdown', async () => {
  const {searchWorkspaceFiles} = await import('../src/tools.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-no-rg-'));
  await mkdir(path.join(root,'docs'));
  await writeFile(path.join(root,'docs/note.md'),'fallback-739');
  const previous = process.env.PATH;
  try {
    process.env.PATH = root;
    const matches = await searchWorkspaceFiles(root,'fallback-739','.',50,undefined,{globs:['*.md']});
    assert.equal(matches[0]?.path,'docs/note.md');
    assert.equal(matches[0]?.match,'content');
  } finally {
    if(previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});
