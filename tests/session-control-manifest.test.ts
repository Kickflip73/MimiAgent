import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MimiAgent } from '../src/runtime/mimi-agent.js';
import { MimiHost } from '../src/runtime/mimi-host.js';
import { FileSession } from '../src/core/session.js';
import { ContextManifestStore } from '../src/core/context-manifest-store.js';
import type { ContextManifest } from '../src/core/context.js';

const manifest = (requestId = 'request', createdAt = '2026-10-09T01:00:00.000Z'): ContextManifest => ({
  sessionId: 'sample', runId: 'run', requestId, createdAt, provider: 'test', model: 'test', estimator: 'test',
  contextWindow: 10000, outputReserve: 1000, availableInputBudget: 9000, estimatedInputTokens: 123,
  sections: [{ id: 'current-input', estimatedTokens: 123, truncated: false }], compression: [],
});

test('context metadata survives restart, resists stale writes and never repairs on read', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-manifest-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const store = new ContextManifestStore(root);
  assert.equal(await store.read('sample'), undefined);
  const latest = {...manifest(), actual: {inputTokens:122,outputTokens:3,totalTokens:125,receivedAt:'2026-10-09T01:00:01.000Z'}};
  await store.save(latest);
  await store.save(manifest());
  await store.save(manifest('old', '2026-10-08T01:00:00.000Z'));
  assert.deepEqual(await new ContextManifestStore(root).read('sample'), latest);
  await writeFile(path.join(root,'broken.json'), '{invalid');
  assert.equal(await store.read('broken'), undefined);
  assert.equal(await readFile(path.join(root,'broken.json'),'utf8'), '{invalid');
  await symlink(path.join(root,'sample.json'),path.join(root,'link.json'));
  assert.equal(await store.read('link'), undefined);
  await assert.rejects(store.save({...manifest(),estimatedInputTokens:-1}));
  await writeFile(path.join(root,'sample.json'), '{broken');
  await store.save(manifest());
  assert.deepEqual(await store.read('sample'), manifest());
  await store.clear('sample');
  assert.equal(await store.read('sample'), undefined);
});

test('next-turn controls persist during a held run without creating another actor or mutating active mode', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(),'mimi-controls-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const session = new FileSession(root,'sample'); await session.ensure();
  const agent = Object.assign(Object.create(MimiAgent.prototype), {
    config: {}, sessionId:'sample', session, mode:'general', outputLevel:'tools',
    components:{state:{sessions:{open:(id:string)=>new FileSession(root,id)}},
      modelGateway:{inspect:()=>({kind:'agent',capabilities:{toolCalling:true}})}},
    refreshModelConfiguration:async()=>undefined,
    close:async()=>undefined,
  }) as MimiAgent;
  let release!:()=>void, started!:()=>void;
  const entered = new Promise<void>(resolve=>{started=resolve;});
  const held = new Promise<void>(resolve=>{release=resolve;});
  const host = new MimiHost(agent,{execute:async()=>{started();await held;return {answer:'ok',effects:[]};}}, {
    createSessionRuntime:async()=>{throw new Error('control must not create a runtime');},
  });
  const run=host.execute({sessionId:'sample',input:'work'}); await entered;
  try {
    assert.equal((await host.setSessionPreference('sample','mode.set','plan')).effective,'next_run');
    await host.setSessionPreference('cold','output.set','answer');
    await host.setSessionPreference('sample','model.control',{action:'use',target:{providerId:'test',modelId:'test'}});
    assert.equal((await session.getPreferences()).mode,'plan');
    assert.equal(agent.mode,'general');
    assert.equal((await new FileSession(root,'cold').getPreferences()).outputLevel,'answer');
    await assert.rejects(host.setSessionPreference('sample','mode.set','invalid'));
    await host.setSessionPreference('sample','model.control',{action:'auto'});
    assert.equal((await session.getPreferences()).modelTarget,undefined);
  } finally { release(); await run; await host.close(); }
});

test('task list avoids touching heavyweight result bodies', async () => {
  const { taskListItem } = await import('../src/daemon/task-inspection.js');
  const task = { id:'task',status:'running',sessionKey:'session',objective:{objective:'a'.repeat(2000)},
    executor:'mimi',attemptCount:1,createdAt:'now',updatedAt:'now',notBefore:'now',
    get result() { throw new Error('list must not read result'); },
  } as unknown as import('../src/daemon/types.js').TaskRecord;
  const row=taskListItem(task);
  assert.equal(row.objective?.length,500);
  assert.ok(!('result' in row));
});
