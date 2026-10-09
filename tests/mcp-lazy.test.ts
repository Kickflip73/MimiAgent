import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext, tool } from '@openai/agents';
import { z } from 'zod';
import { MCPManager } from '../src/extensions/mcp.js';
import { HostCapabilityRegistry } from '../src/runtime/pipeline/capability-registry.js';
import { MimiAgent } from '../src/runtime/mimi-agent.js';

const fixture = new URL('./fixtures/mcp-environment-fixture.mjs', import.meta.url).pathname;
test('cold Agent creates no MCP process, owns scoped credentials after worker cleanup, and connects once on demand',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'mimi-lazy-mcp-'));const marker=path.join(root,'started.json');const config=path.join(root,'mcp.json');
  await writeFile(config,JSON.stringify({mcpServers:{probe:{command:process.execPath,args:[fixture,marker],allowedEnv:['SCOPED_TOKEN'],env:{INJECTED_MCP_TOKEN:'${SCOPED_TOKEN}'}}}}));
  const env={SCOPED_TOKEN:'fixture-token'};
  const agent=await MimiAgent.create({provider:'openai',workspaceRoot:root,dataRoot:path.join(root,'.mimi-agent'),skillsRoot:path.join(root,'skills'),mcpConfig:config,trustedWorkspaceMcp:root,historyLimit:20,maxTurns:5},'fixture',{mcpEnvironment:env,releaseMcpEnvironmentAfterConnect:true});
  try {
    env.SCOPED_TOKEN='';
    await assert.rejects(access(marker));
    const mcp=agent.components.mcp;
    assert.equal(mcp.statuses()[0]?.state,'configured');
    await Promise.all([mcp.ensureConnected(),mcp.ensureConnected()]);
    const first=mcp.servers[0];assert.ok(first);
    assert.equal(JSON.parse(await readFile(marker,'utf8')).injected,'fixture-token');
    await mcp.ensureConnected();assert.equal(mcp.servers[0],first);
    await mcp.reload();assert.notEqual(mcp.servers[0],first);
  }finally{await agent.close();await rm(root,{recursive:true,force:true});}
});

test('lazy MCP registry rejects unknown services and preserves deferred invocation and evolving snapshots',async()=>{
  let loads=0,calls=0,state='configured';
  const candidate=tool({name:'mcp_probe__echo',description:'echo',parameters:z.object({text:z.string()}),execute:async({text})=>{calls++;return text;}});
  const registry=new HostCapabilityRegistry([],undefined,undefined,{statuses:()=>[{name:'probe',state,tools:state==='connected'?1:0}],load:async()=>{loads++;state='connected';return [candidate];}});
  const gateway=registry.gatewayTools([]);const inspect=gateway[0] as any,invoke=gateway[1] as any;const context=new RunContext({});
  assert.equal(registry.snapshot({runId:'r',policyRevision:'owner',modelTools:gateway}).items.find(item=>item.id==='mcp-server:probe')?.readiness,'unknown');
  await inspect.invoke(context,JSON.stringify({source:'builtin',query:'files'}),{});assert.equal(loads,0);
  const denied=await invoke.invoke(context,JSON.stringify({name:'mcp_unknown__echo',argumentsJson:'{"text":"hello"}'}),{});assert.match(String(denied),/未授权/);assert.equal(loads,0);
  const found=await inspect.invoke(context,JSON.stringify({source:'mcp',name:'mcp_probe__echo'}),{});assert.equal(found.resolution.status,'deferred');assert.equal(found.mcpCatalog[0].state,'connected');
  assert.equal(await invoke.invoke(context,JSON.stringify({name:'mcp_probe__echo',argumentsJson:'{"text":"hello"}'}),{}),'hello');assert.equal(calls,1);
  await inspect.invoke(context,JSON.stringify({source:'mcp',name:'mcp_probe__echo'}),{});assert.equal(loads,1);
  const snapshot=registry.snapshot({runId:'r',policyRevision:'owner',modelTools:gateway});assert.equal(snapshot.items.find(item=>item.id==='mcp-server:probe')?.readiness,'ready');assert.equal(snapshot.hiddenTools[0]?.names[0],'mcp_probe__echo');
});

test('failed lazy connection can be retried explicitly and closed managers never restart',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'mimi-lazy-retry-'));const config=path.join(root,'mcp.json');const marker=path.join(root,'started.json');let disposed=false;
  const manager=new MCPManager(config,root,{disposeEnvironment:()=>{disposed=true;}});
  try {
    await writeFile(config,JSON.stringify({mcpServers:{probe:{command:'/missing-mimi-fixture'}}}));await manager.prepare();await manager.ensureConnected();assert.equal(manager.statuses()[0]?.state,'failed');
    await writeFile(config,JSON.stringify({mcpServers:{probe:{command:process.execPath,args:[fixture,marker]}}}));await manager.ensureConnected();assert.equal(manager.statuses()[0]?.state,'connected');
    await manager.close();assert.equal(disposed,true);await assert.rejects(manager.ensureConnected(),/已关闭/);
  }finally{await manager.close();await rm(root,{recursive:true,force:true});}
});

test('real lazy pipeline respects denied policy and preserves MCP at-most-once ledger',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'mimi-lazy-pipeline-'));const serverFile=path.join(root,'server.mjs');const marker=path.join(root,'calls.txt');const config=path.join(root,'mcp.json');
  await writeFile(serverFile,`import{appendFileSync}from'node:fs';import readline from'node:readline';appendFileSync(process.argv[2],'start\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;let result={};if(r.method==='initialize')result={protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'probe',version:'1'}};if(r.method==='tools/list')result={tools:[{name:'echo',description:'Echo fixture',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}]};if(r.method==='tools/call'){appendFileSync(process.argv[2],'call\\n');result={content:[{type:'text',text:r.params.arguments.text}]};}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');});`);
  await writeFile(config,JSON.stringify({mcpServers:{probe:{command:process.execPath,args:[serverFile,marker]}}}));
  await mkdir(path.join(root,'skills','probe'),{recursive:true});
  await writeFile(path.join(root,'skills','probe','SKILL.md'),'---\nname: probe\ndescription: explicit MCP skill\nrequired-tools: mcp_probe__echo\n---\nMCP_SKILL_INSTRUCTION');
  const agent=await MimiAgent.create({provider:'openai',workspaceRoot:root,dataRoot:path.join(root,'.mimi-agent'),skillsRoot:path.join(root,'skills'),mcpConfig:config,trustedWorkspaceMcp:root,historyLimit:20,maxTurns:5},'fixture');
  const runner=(agent as any).runner;
  try {
    runner.run=async(runtime:any)=>{
      const inspect=runtime.tools.find((t:any)=>t.name==='inspect_capabilities');
      const denied=await inspect.invoke(new RunContext({}),JSON.stringify({source:'mcp',query:'echo'}),{});
      assert.equal(denied.matchedCount,0);await assert.rejects(access(marker));return {};
    };
    await agent.stream('read only',undefined,{securityProfile:'safe'});await agent.failRun(new Error('fixture boundary'),true);
    runner.run=async(runtime:any)=>{
      assert.match(runtime.instructions,/MCP_SKILL_INSTRUCTION/);
      assert.equal(agent.activeRun?.availableToolNames?.includes('mcp_probe__echo'),true);
      const inspect=runtime.tools.find((t:any)=>t.name==='inspect_capabilities'),invoke=runtime.tools.find((t:any)=>t.name==='invoke_capability');
      const context=new RunContext({});
      await invoke.invoke(context,JSON.stringify({name:'mcp_probe__echo',argumentsJson:'{"text":"fixture"}'}),{toolCall:{callId:'known-name'}});
      const catalog=await inspect.invoke(context,JSON.stringify({source:'mcp',query:'echo'}),{});
      const name=catalog.capabilities[0].name;await inspect.invoke(context,JSON.stringify({source:'mcp',name}),{});
      const args=JSON.stringify({name,argumentsJson:'{"text":"fixture"}'});
      await invoke.invoke(context,args,{toolCall:{callId:'one'}});await invoke.invoke(context,args,{toolCall:{callId:'two'}});
      assert.equal((await readFile(marker,'utf8')).split('\n').filter(value=>value==='call').length,1);
      assert.equal(agent.activeRun?.capabilitySnapshot?.items.find(item=>item.kind==='mcp')?.readiness,'ready');
      return {};
    };
    await assert.rejects(agent.stream('$probe use MCP',undefined,{securityProfile:'safe'}),/缺少必需工具/);
    await assert.rejects(access(marker));await agent.failRun(new Error('fixture boundary'),true);
    await agent.stream('$probe use MCP',undefined,{executionKey:'mcp-lazy-ledger'});await agent.failRun(new Error('fixture boundary'),true);
    runner.run=async(runtime:any)=>{assert.match(runtime.instructions,/MCP_SKILL_INSTRUCTION/);assert.equal(agent.activeRun?.availableToolNames?.includes('mcp_probe__echo'),true);return {};};
    await agent.stream('resume explicitly',undefined,{resumeState:true});await agent.failRun(new Error('fixture boundary'),true);
  }finally{await agent.close();await rm(root,{recursive:true,force:true});}
});
