import assert from 'node:assert/strict';
import test from 'node:test';
import { RunContext } from '@openai/agents';
import { z } from 'zod';
import { tool } from '../src/tool-factory.js';

test('SDK validation exposes bounded corrective constraints before dispatch without input values', async () => {
  let calls = 0;
  const candidate = tool({name:'probe',description:'probe',parameters:z.object({limit:z.number().int().min(1).max(20).optional(),secret:z.string().max(3).optional()}),execute:async()=>{calls++;return 'ok';}});
  const result = await candidate.invoke(new RunContext({}),JSON.stringify({limit:30,secret:'sensitive-value'})) as unknown as Record<string, any>;
  assert.equal(calls,0);
  assert.equal(result.code,'tool_input_invalid');
  assert.deepEqual(result.disposition,{phase:'pre_dispatch',kind:'validation',dispatchStarted:false,toolName:'probe'});
  assert.equal(result.issues[0].path,'limit');
  assert.equal(result.issues[0].maximum,20);
  assert.doesNotMatch(JSON.stringify(result),/sensitive-value/);
  const schema = candidate.parameters as any;
  assert.match(schema.properties.limit.description,/maximum.*20/);
  assert.match(schema.properties.secret.description,/maxLength.*3/);
});

test('execution errors never claim validation or a safe dispatch boundary',async()=>{
  const candidate=tool({name:'exec',description:'probe',parameters:z.object({}),execute:async()=>{throw new Error('failure');}});
  const result=await candidate.invoke(new RunContext({}),'{}') as unknown as Record<string,unknown>;
  assert.equal(result.code,'tool_execution_failed'); assert.equal(result.disposition,undefined);
});

test('production ledger preserves corrective validation details and records no successful side effect',async()=>{
  const {mkdtemp,rm}=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');
  const {ExecutionLedger}=await import('../src/core/execution-ledger.js');const {withExecutionLedger}=await import('../src/runtime/tool-ledger.js');
  const root=await mkdtemp(path.join(os.tmpdir(),'mimi-validation-ledger-'));
  try {
    const ledger=new ExecutionLedger(path.join(root,'ledger.json'));let executions=0;
    const original=tool({name:'write_file',description:'fixture',parameters:z.object({path:z.string(),content:z.string(),limit:z.number().max(20)}),execute:async()=>{executions++;return 'ok';}});
    const [wrapped]=withExecutionLedger([original],ledger,()=>({sessionId:'test',runId:'validation'}));assert.ok(wrapped && 'invoke' in wrapped);
    const result=await wrapped.invoke(new RunContext({}),JSON.stringify({path:'file.txt',content:'fixture',limit:30}),{toolCall:{callId:'invalid'}} as never) as unknown as Record<string,any>;
    assert.equal(executions,0);assert.equal(result.code,'tool_input_invalid');assert.equal(result.issues[0].path,'limit');assert.equal(result.disposition.dispatchStarted,false);
    const [record]=await ledger.listCalls('test','validation');assert.equal(record?.status,'failed');
  }finally{await rm(root,{recursive:true,force:true});}
});
