import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext } from '@openai/agents';
import { SkillLoader } from '../src/extensions/skills.js';
import { HostCapabilityRegistry } from '../src/runtime/pipeline/capability-registry.js';

test('Skill index is bounded and exact discovery navigates directly to authorized activation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'mimi-skill-index-'));
  try {
    for (let index=0;index<30;index++) {
      const name=`probe-${index}`; await mkdir(path.join(root,name));
      await writeFile(path.join(root,name,'SKILL.md'),`---\nname: ${name}\ndescription: ${'bounded discoverable instruction '.repeat(30)}\n---\nFollow the actual instructions.`);
    }
    const loader=new SkillLoader(root);await loader.load();const tools=loader.createTools();
    const listed=await tools.find(t=>t.name==='list_skills')!.invoke(new RunContext({}),'{}') as any;
    assert.equal(listed.skills.length,25);assert.equal(listed.nextOffset,25);
    assert.ok(JSON.stringify(listed).length<12000);assert.doesNotMatch(JSON.stringify(listed),/contentHash|\/SKILL.md/);
    const registry=new HostCapabilityRegistry(tools,undefined,(filter)=>loader.inspectCatalog(filter,{canReadLocal:true}));
    const gateway=registry.gatewayTools(tools);const inspect=gateway.find(t=>t.name==='inspect_capabilities')! as any;
    const found=await inspect.invoke(new RunContext({}),JSON.stringify({source:'skill',name:'probe-29'}),{});
    assert.equal(found.skillCatalog.skills[0].name,'probe-29');assert.equal(found.resolution.status,'skill');
    const invoke=gateway.find(t=>t.name==='invoke_capability')! as any;
    const activated=await invoke.invoke(new RunContext({}),JSON.stringify({name:'use_skill',argumentsJson:'{"name":"probe-29"}'}),{});
    assert.match(activated.instructions,/actual instructions/);
    const denied=new HostCapabilityRegistry([],undefined,()=>{throw new Error('must not expose denied skills');});
    const deniedInspect=denied.gatewayTools([]).find(t=>t.name==='inspect_capabilities')! as any;
    const hidden=await deniedInspect.invoke(new RunContext({}),JSON.stringify({source:'skill',name:'probe-29'}),{});
    assert.equal(hidden.resolution.status,'unavailable');
  } finally {await rm(root,{recursive:true,force:true});}
});
