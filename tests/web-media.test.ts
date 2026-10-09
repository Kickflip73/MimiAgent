import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mediaAttachment, mediaIds } from '../src/core/media-attachment.js';
import { saveMedia, readMedia, inputWithMedia, mediaRecord } from '../src/runtime/media-input.js';
import { FileSession } from '../src/core/session.js';
import { readOutputMedia } from '../src/web/media-output.js';
// @ts-expect-error Browser module.
import { createMediaDrafts, outputMedia } from '../src/web/assets/media.js';
// @ts-expect-error Browser module.
import { createRecorder } from '../src/web/assets/recorder.js';
const wav=Buffer.from('RIFF0000WAVEfmt synthetic test payload');

test('voice reaches model as transcript, retaining a small playable reference in canonical history',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'mimi-media-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const ref={...await saveMedia(root,wav,'audio/x-wav'),duration:3,transcript:'明天下午检查项目'};
 await mediaRecord(root,ref.id).replace(ref);
 assert.deepEqual(await mediaRecord(root,ref.id).read(),ref);
 assert.deepEqual((await readMedia(root,ref.id)).data,wav);
 const input=await inputWithMedia('','',[ref],root) as any[];
 assert.match(input[0].content.at(-1).text,/明天下午检查项目/);
 const session=new FileSession(path.join(root,'sessions'),'voice');await session.addItems(input);
 const restored=await new FileSession(path.join(root,'sessions'),'voice').getItems();
 assert.deepEqual((restored[0] as any).mediaAttachments,[ref]);assert.equal((restored[0] as any).displayText,'');
 assert.ok(!(await readFile(path.join(root,'sessions','voice.json'),'utf8')).includes(wav.toString('base64')));
 await assert.rejects(inputWithMedia('','',[{...ref,transcript:undefined}],root),/尚未识别/);
});

test('media rejects forged types, traversal and symlinks',async t=>{
 assert.throws(()=>mediaAttachment(Buffer.from('<script>'),'audio/wav'),/格式不符/);
 assert.throws(()=>mediaIds(['../secret.wav']));assert.throws(()=>mediaIds(Array(9).fill(mediaAttachment(wav,'audio/wav').id)));
 const root=await mkdtemp(path.join(os.tmpdir(),'mimi-media-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const id=mediaAttachment(wav,'audio/wav').id;await symlink('/etc/hosts',path.join(root,id));await assert.rejects(readMedia(root,id));
});

test('assistant media requires a reference in this session and a permitted file root',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'mimi-output-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const data=path.join(root,'data'),workspace=path.join(root,'workspace');await mkdir(path.join(data,'sessions'),{recursive:true});await mkdir(workspace);
 const file=path.join(workspace,'answer.wav');await writeFile(file,wav);
 const history=path.join(data,'sessions','s.json');await writeFile(history,JSON.stringify({items:[{role:'user',content:file}]}));
 await assert.rejects(readOutputMedia(data,workspace,'s',file),/未引用/);
 await writeFile(history,JSON.stringify({items:[{role:'assistant',content:`[录音](${file})`}]}));
 assert.deepEqual((await readOutputMedia(data,workspace,'s',file)).data,wav);
 const outside=path.join(root,'secret.wav');await writeFile(outside,wav);const link=path.join(workspace,'link.wav');await symlink(outside,link);
 await writeFile(history,JSON.stringify({items:[{role:'assistant',content:link}]}));await assert.rejects(readOutputMedia(data,workspace,'s',link),/工作区/);
 await assert.rejects(readOutputMedia(data,workspace,'../s',file));
});

test('media drafts retain failed recognition for retry and do not resurrect removed uploads',async()=>{
 const values=new Map();const storage={getItem:(k:string)=>values.get(k),setItem:(k:string,v:string)=>values.set(k,v)};
 const ref=mediaAttachment(wav,'audio/wav');let fail=true;
 const options={storage,upload:async()=>ref,prepare:async()=>{if(fail)throw new Error('offline');return {...ref,transcript:'你好',duration:2};},changed:()=>{}};
 const drafts=createMediaDrafts(options);await drafts.add('s',new File([wav],'voice.wav',{type:'audio/wav'}));
 assert.equal(drafts.list('s')[0].error,'offline');assert.equal(drafts.list('s')[0].ready,undefined);
 const reload=createMediaDrafts(options);assert.equal(reload.list('s')[0].id,ref.id);fail=false;await reload.retry('s',reload.list('s')[0].key);assert.equal(reload.list('s')[0].transcript,'你好');
 let resolve!:(v:unknown)=>void;const pending=new Promise(r=>resolve=r);const other=createMediaDrafts({...options,upload:()=>pending});
 const add=other.add('b',new File([wav],'voice.wav',{type:'audio/wav'}));other.remove('b',other.list('b')[0].key);resolve(ref);await add;assert.deepEqual(other.list('b'),[]);
 assert.ok(!values.get('mimi-media:s').includes('base64'));
});

test('output blocks recognize media links but never code examples or executable URLs',()=>{
 const refs=outputMedia('[声音](/tmp/voice.wav)\n![图](https://example.com/a.png)\n[video](https://example.com/v.mp4)\n[x](javascript:alert)\n```sh\n`/tmp/example.mp4`\n```','s');
 assert.deepEqual(refs.map((r:any)=>r.kind),['audio','image','video']);assert.match(refs[0].src,/session=s/);
});

test('recorder releases microphone on completion, failed startup and late permission cancellation',async()=>{
 let stopped=0,complete=0,errors=0,instance:any;
 const stream={getTracks:()=>[{stop:()=>stopped++}]};
 class Recorder {static isTypeSupported(){return true;}state='inactive';mimeType='audio/webm';ondataavailable:any;onstop:any;constructor(){instance=this;}start(){this.state='recording';}stop(){this.state='inactive';this.ondataavailable({data:new Blob(['data'])});this.onstop();}}
 const options={mediaDevices:{getUserMedia:async()=>stream},Recorder,changed:()=>{},complete:()=>complete++,error:()=>errors++};
 const recording=createRecorder(options);await recording.start('a');assert.equal(recording.active,true);recording.stop();assert.equal(stopped,1);assert.equal(complete,1);assert.equal(recording.active,false);
 class Broken extends Recorder {start(){throw new Error('device disconnected');}}
 const broken=createRecorder({...options,Recorder:Broken});await broken.start('a');assert.equal(broken.active,false);assert.equal(errors,1);assert.equal(stopped,2);
 let grant!:(v:any)=>void;const delayed=createRecorder({...options,mediaDevices:{getUserMedia:()=>new Promise(r=>grant=r)}});const starting=delayed.start('a');delayed.cancel();grant(stream);await starting;assert.equal(stopped,3);assert.equal(complete,1);assert.equal(delayed.active,false);
});
