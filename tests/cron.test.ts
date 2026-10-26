import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextCronTime } from '../src/daemon/cron.js';

test('cron supports minute steps, ranges, lists and Sunday alias', () => {
  const after = new Date(2026, 9, 8, 9, 13, 24);
  assert.equal(nextCronTime('*/15 9-17 * * 1-5', after).getTime(), new Date(2026, 9, 8, 9, 15).getTime());
  assert.equal(nextCronTime('0 8,18 * * 7', after).getTime(), new Date(2026, 9, 11, 8).getTime());
  assert.equal(nextCronTime('0 9 * * *', new Date(2026,9,8,9)).getTime(), new Date(2026,9,9,9).getTime());
});
test('cron handles leap years and combines restricted month days and weekdays with OR', () => {
  assert.equal(nextCronTime('0 0 29 2 *', new Date(2025,2,1)).getTime(),new Date(2028,1,29).getTime());
  assert.equal(nextCronTime('0 9 1 * 1',new Date(2026,9,8)).getTime(),new Date(2026,9,12,9).getTime());
  for(const expression of ['* * * *','60 * * * *','*/0 * * * *','1-0 * * * *','0 0 31 2 *','0 0 * * 8','@daily']) assert.throws(()=>nextCronTime(expression,new Date(2026,0,1)),/cron/i);
});

test('cron occurrences survive reopen, skip missed slots, and retain paged execution history', async t => {
  const {mkdtemp,rm}=await import('node:fs/promises');
  const os=await import('node:os'), path=await import('node:path');
  const {MimiStore}=await import('../src/daemon/store.js');
  const root=await mkdtemp(path.join(os.tmpdir(),'mimi-cron-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const file=path.join(root,'mimi.db'); let store=new MimiStore(file);
  t.after(()=>store.close());
  const due=new Date(2026,9,8,9);
  // Routing also reads wall time; keep the entire fixture on the same clock.
  t.mock.timers.enable({apis:['Date'],now:due});
  const schedule=store.schedules.add({name:'morning',type:'cron',value:'0 9 * * *',prompt:'test',profileId:'owner',trust:'owner',sessionKey:'schedule-owner',nextRunAt:due.toISOString()});
  assert.throws(()=>store.schedules.add({...schedule,value:'bad cron'}),/cron/);
  assert.equal(store.schedules.count(),1);
  store.close();store=new MimiStore(file);
  const after=new Date(2026,9,10,12);
  assert.equal(store.schedules.emitDue(after).length,1);
  assert.equal(store.schedules.emitDue(after).length,0);
  assert.equal(store.schedules.get(schedule.id)?.nextRunAt,new Date(2026,9,11,9).toISOString());
  const task=store.listTasks()[0]!;
  const claimed=store.claimTaskById(task.id,'worker',60_000,after)!;
  const run=store.beginTaskAttempt(task.id,'worker',claimed.sessionKey!,'worker',after);
  const history=store.schedules.history(schedule.id);
  assert.equal(history.items.length,1);
  assert.equal(history.items[0]!.runId,run.id);
  assert.equal(history.items[0]!.sessionId,run.sessionKey);
  assert.equal(history.items[0]!.status,'running');
  // Recurring work does not overlap an unfinished occurrence.
  store.completeTask(task.id, 'worker', { answer: 'done' }, run.id, new Date(after.getTime()+1_000));
  store.schedules.emitDue(new Date(2026,9,11,10));
  const page=store.schedules.history(schedule.id,0,1);
  assert.equal(page.items.length,1);assert.equal(page.nextOffset,1);
  assert.equal(store.schedules.history(schedule.id,1,1).items.length,1);
  assert.equal(store.schedules.history('unrelated').items.length,0);
});

test('schedule edits retain identity and history, reject stale edits, and pause future emissions',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const os=await import('node:os'),path=await import('node:path');const {MimiStore}=await import('../src/daemon/store.js');
 const root=await mkdtemp(path.join(os.tmpdir(),'mimi-schedule-edit-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=new MimiStore(path.join(root,'db'));t.after(()=>store.close());
 const now=new Date(2026,9,9,12);const original=store.schedules.add({name:'old',prompt:'old',type:'interval',value:'86400000',profileId:'owner',trust:'owner',nextRunAt:now.toISOString()});
 const updated=store.schedules.update(original.id,{name:'new',prompt:'new',type:'cron',value:'0 9 * * *'},original.updatedAt,now);
 assert.equal(updated.id,original.id);assert.equal(updated.authorityEventId,original.authorityEventId);assert.equal(updated.nextRunAt,new Date(2026,9,10,9).toISOString());
 assert.throws(()=>store.schedules.update(original.id,{name:'stale'},original.updatedAt,now),/变化/);
 const paused=store.schedules.update(original.id,{enabled:false},updated.updatedAt,now);assert.equal(store.schedules.emitDue(new Date(2026,9,11,10)).length,0);
 const enabled=store.schedules.update(original.id,{enabled:true},paused.updatedAt,new Date(2026,9,11,10));assert.equal(enabled.nextRunAt,new Date(2026,9,12,9).toISOString());assert.equal(store.schedules.emitDue(new Date(2026,9,12,9)).length,1);
});
