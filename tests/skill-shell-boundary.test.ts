import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SkillLoader } from '../src/extensions/skills.js';
import { SkillPreferenceStore } from '../src/extensions/skill-preferences.js';
import { runShellCommand } from '../src/tools.js';

const quote=(value:string)=>`'${value.replaceAll("'", "'\\''")}'`;
test('authorized Skill scripts are readable/executable but private data and Skill writes stay denied', {skip:process.platform!=='darwin'}, async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'mimi-skill-shell-'));const privateRoot=path.join(root,'.mimi-agent');const skill=path.join(privateRoot,'skills','probe');
  await mkdir(skill,{recursive:true}); await mkdir(path.join(privateRoot,'sessions'));
  await writeFile(path.join(privateRoot,'sessions','secret'),'private-state');await writeFile(path.join(skill,'script.sh'),'printf skill-ok');
  await symlink(path.join(privateRoot,'sessions'),path.join(skill,'escape'));
  const run=(command:string,readRoots:string[]=[])=>runShellCommand(root,command,5,undefined,[privateRoot],{PATH:'/usr/bin:/bin'},false,[],[],[],false,readRoots);
  try {
    const blocked=await run(`/bin/sh ${quote(path.join(skill,'script.sh'))}`);assert.notEqual(blocked.exitCode,0);
    const allowed=await run(`/bin/sh ${quote(path.join(skill,'script.sh'))}`,[skill]);assert.equal(allowed.exitCode,0,allowed.stderr);assert.equal(allowed.stdout,'skill-ok');
    const denied=await run(`/bin/cat ${quote(path.join(skill,'escape','secret'))}`,[skill]);assert.notEqual(denied.exitCode,0);assert.doesNotMatch(denied.stdout,/private-state/);
    const write=await run(`printf changed > ${quote(path.join(skill,'script.sh'))}`,[skill]);assert.notEqual(write.exitCode,0);assert.equal(await readFile(path.join(skill,'script.sh'),'utf8'),'printf skill-ok');
    await assert.rejects(run('true',[privateRoot]),/私有根|protected root/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('execution roots require an active current binding and honor read/execute rights and disabling',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'mimi-skill-roots-'));const dir=path.join(root,'skills','probe');
  await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'SKILL.md'),'---\nname: probe\ndescription: test skill\n---\nExecute script.');
  try {
    const loader=new SkillLoader(path.join(root,'skills'),new SkillPreferenceStore(path.join(root,'project.json'),path.join(root,'user.json')));await loader.load();
    const skill=loader.get('probe')!;const binding={name:skill.name,sourceId:skill.source.id,file:skill.file,contentHash:skill.contentHash,activatedAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    const access={canReadLocal:true,availableTools:['run_shell']};
    assert.deepEqual(await loader.executionRoots([],access),[]);
    assert.equal((await loader.executionRoots([binding],access)).length,1);
    assert.deepEqual(await loader.executionRoots([binding],{canReadLocal:false,availableTools:['run_shell']}),[]);
    assert.deepEqual(await loader.executionRoots([binding],{canReadLocal:true,availableTools:[]}),[]);
    assert.deepEqual(await loader.executionRoots([{...binding,contentHash:'changed'}],access),[]);
    await loader.setEnabled('probe','user',false);
    assert.deepEqual(await loader.executionRoots([binding],access),[]);
  }finally{await rm(root,{recursive:true,force:true});}
});
