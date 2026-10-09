import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error Browser-only ES module.
import { createMessageQueue } from '../src/web/assets/queue.js';
// @ts-expect-error Browser-only ES module.
import { contextBreakdown } from '../src/web/assets/context.js';

function fixture() {
  const values = new Map<string,string>(); let sequence = 0;
  const running = new Map<string,string>(); const submitted: any[] = []; const accepted: any[] = [];
  const config = { storage: {getItem:(k:string)=>values.get(k),setItem:(k:string,v:string)=>values.set(k,v)},
    uuid:()=>String(++sequence), changed:()=>{},
    isRunning: async (session:string)=>running.get(session),
    interrupt: async (session:string)=>{running.delete(session);},
    submit: async (item:any)=>{submitted.push({...item});return {eventId:'run-'+item.id};},
    accepted: async (item:any,result:any)=>{running.set(item.session,result.eventId);accepted.push(item.id);},
  };
  return {config,running,submitted,accepted,queue:createMessageQueue(config)};
}
test('queued drafts survive refresh, edit/cancel, wait for completion and preserve session order', async()=>{
  const f=fixture();f.running.set('a','old');
  const first=f.queue.add('a','first','safe');const second=f.queue.add('a','second','safe');
  f.queue.edit(second.id,'edited'); const removed=f.queue.add('a','cancel','safe');f.queue.cancel(removed.id);
  const queue=createMessageQueue(f.config);await queue.drain('a');assert.equal(f.submitted.length,0);
  f.running.delete('a');await Promise.all([queue.drain('a'),queue.drain('a')]);
  assert.deepEqual(f.accepted,[first.id]);assert.equal(queue.list('a')[0].input,'edited');
  await queue.drain('a');assert.equal(f.submitted.length,1);
  f.running.delete('a');await queue.drain('a');assert.equal(f.submitted[1].input,'edited');
  assert.equal(queue.list('a').length,0);
});
test('immediate send interrupts first; errors keep drafts and uncertain submissions retry the same ID',async()=>{
  const f=fixture();f.running.set('a','old'); const item=f.queue.add('a','urgent','workstation');
  let interrupted=false;
  f.config.interrupt=async()=>{throw new Error('stop failed');};let q=createMessageQueue(f.config);
  await q.drain('a',item.id);assert.equal(f.submitted.length,0);assert.equal(q.list('a')[0].state,'queued');
  f.config.interrupt=async()=>{interrupted=true;f.running.delete('a');};
  f.config.submit=async (message:any)=>{assert.ok(interrupted);f.submitted.push({...message});throw new Error('lost receipt');};
  q=createMessageQueue(f.config);await q.drain('a',item.id);assert.equal(q.list('a')[0].state,'failed');
  q.cancel(item.id);assert.equal(q.list('a').length,1);
  f.config.submit=async(message:any)=>{f.submitted.push({...message});return {eventId:'accepted'};};
  q=createMessageQueue(f.config);await q.drain('a',item.id);
  assert.equal(f.submitted[0].id,f.submitted[1].id);assert.equal(q.list('a').length,0);
});
test('another session can drain while one remains busy',async()=>{
  const f=fixture();f.running.set('a','old');f.queue.add('a','a','safe');f.queue.add('b','b','safe');
  await Promise.all(f.queue.sessions().map((id:string)=>f.queue.drain(id)));
  assert.equal(f.submitted.length,1);assert.equal(f.submitted[0].session,'b');
});
test('context ring separates reserved capacity and shows honest actual/estimated accounting',()=>{
  const value=contextBreakdown({contextWindow:1000,lastRequestInputTokens:300,sections:[{id:'recent-history',estimatedTokens:100},{id:'tool-schemas',estimatedTokens:100},{id:'protocol-reserve',estimatedTokens:50}]});
  assert.equal(value.percent,30);assert.equal(value.remaining,700);assert.equal(value.actual,true);
  assert.equal(value.sections.length,2);assert.equal(value.sections[0].estimatedTokens,100);assert.equal(value.sections[0].share,150);
  assert.equal(contextBreakdown({}, {contextWindow:1000,contextUsed:0}).percent,0);
  assert.equal(contextBreakdown({}).percent,undefined);
});

test('accepted receipt survives display failure and refresh without resubmitting', async () => {
  const f=fixture(); const item=f.queue.add('a','hello','safe'); let observations=0;
  f.config.accepted=async()=>{ observations++; throw new Error('event.stream timed out'); };
  let q=createMessageQueue(f.config); await q.drain('a',item.id);
  assert.equal(f.submitted.length,1); assert.equal(q.list('a')[0].state,'accepted');
  f.config.accepted=async()=>{ observations++; };
  q=createMessageQueue(f.config); await q.drain('a');
  assert.equal(f.submitted.length,1); assert.equal(observations,2); assert.equal(q.list('a').length,0);
});

test('send now bypasses an outstanding background status probe', async () => {
  const f=fixture(); const item=f.queue.add('a','urgent','safe');
  let release!: (value:string)=>void;
  const delayed=new Promise<string>(resolve=>{release=resolve;});
  f.config.isRunning=async (_session:string, options?:{immediate:boolean})=>options?.immediate?'old':delayed;
  const q=createMessageQueue(f.config); const polling=q.drain('a');
  await q.drain('a',item.id); assert.equal(f.submitted.length,1);
  release('old'); await polling; assert.equal(f.submitted.length,1); assert.equal(q.list('a').length,0);
});

test('lost receipt retry never cancels the request that may already be running', async () => {
  const f=fixture(); const item=f.queue.add('a','once','safe'); let interrupts=0;
  f.config.interrupt=async()=>{interrupts++;};
  f.config.submit=async (message:any)=>{f.submitted.push({...message});f.running.set('a','already-accepted');throw new Error('lost acknowledgement');};
  const q=createMessageQueue(f.config); await q.drain('a',item.id);
  f.config.submit=async(message:any)=>{f.submitted.push({...message});return {eventId:'already-accepted'};};
  const restored=createMessageQueue(f.config);await restored.drain('a',item.id);
  assert.equal(interrupts,0);assert.equal(f.submitted[0].id,f.submitted[1].id);
});

test('repeated send-now clicks serialize one interruption and submission', async () => {
  const f=fixture();f.running.set('a','old');const item=f.queue.add('a','urgent','safe');let interrupts=0;
  let release!:()=>void;const stopped=new Promise<void>(resolve=>{release=resolve;});
  f.config.interrupt=async()=>{interrupts++;await stopped;};const q=createMessageQueue(f.config);
  const first=q.drain('a',item.id);await Promise.resolve();const second=q.drain('a',item.id);
  release();await Promise.all([first,second]);assert.equal(interrupts,1);assert.equal(f.submitted.length,1);
});
