import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { imageAttachment, imageIds, IMAGE_MAX_BYTES } from '../src/core/image-attachment.js';
import { saveWebImage, readWebImage } from '../src/web/images.js';
import { stageAttachments, inputWithAttachments } from '../src/runtime/attachments.js';
import { FileSession } from '../src/core/session.js';
import { MimiHost } from '../src/runtime/mimi-host.js';
import type { MimiAgent } from '../src/runtime/mimi-agent.js';
// @ts-expect-error Browser module.
import {createImageDrafts} from '../src/web/assets/images.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');

test('uploaded image reaches native multimodal input and retains a small history preview reference',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'mimi-web-image-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const uploads=path.join(root,'web-images'), snapshots=path.join(root,'attachments');
  const image=await saveWebImage(uploads,png,'image/png');
  assert.deepEqual(await saveWebImage(uploads,png,'image/png'),image);
  const staged=await stageAttachments([{path:image.id,kind:'image'}],uploads,snapshots);
  const input=await inputWithAttachments('看图',staged);
  assert.ok(Array.isArray(input));assert.equal((input[0] as any).content[1].image,`data:image/png;base64,${png.toString('base64')}`);
  const session=new FileSession(path.join(root,'sessions'),'image-chat');
  const host=new MimiHost({currentSessionId:'image-chat',close:async()=>{}} as unknown as MimiAgent,{
    execute:async request=>{
      assert.deepEqual(request.modelInput,input,'Session host must preserve native image input');
      await session.addItems(request.modelInput!);
      return {answer:'image received',effects:[]};
    },
  });
  await host.execute({sessionId:'image-chat',input:'看图',modelInput:input});await host.close();
  const restored=await new FileSession(path.join(root,'sessions'),'image-chat').getItems();
  assert.deepEqual((restored[0] as any).imageAttachments,[image]);
  const saved=await readFile(path.join(root,'sessions','image-chat.json'),'utf8');
  assert.ok(!saved.includes(png.toString('base64')));
  assert.deepEqual((await readWebImage([uploads,snapshots],image.id)).data,png);
  await rm(path.join(uploads,image.id));
  assert.deepEqual((await readWebImage([uploads,snapshots],image.id)).data,png);
});

test('image boundary rejects unsupported/oversized uploads, arbitrary paths and symlinks',async t=>{
  assert.throws(()=>imageAttachment(Buffer.from('<svg/>'),'image/svg+xml'),/仅支持/);
  assert.throws(()=>imageAttachment(Buffer.from('not png'),'image/png'),/格式不符/);
  assert.throws(()=>imageAttachment(Buffer.alloc(IMAGE_MAX_BYTES+1),'image/png'),/10MB/);
  assert.throws(()=>imageIds(['../../secret']),/标识/);
  assert.throws(()=>imageIds(Array(9).fill(imageAttachment(png,'image/png').id)),/最多/);
  const root=await mkdtemp(path.join(os.tmpdir(),'mimi-web-image-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await symlink('/etc/hosts',path.join(root,imageAttachment(png,'image/png').id));
  await assert.rejects(readWebImage([root],imageAttachment(png,'image/png').id));
});

test('image drafts survive reload by reference; removal during upload cannot resurrect an image',async()=>{
  const values=new Map();const storage={getItem:(key:string)=>values.get(key),setItem:(key:string,value:string)=>values.set(key,value)};
  const image=imageAttachment(png,'image/png');let complete!:(value:unknown)=>void;
  const pending=new Promise(resolve=>{complete=resolve;});
  const drafts=createImageDrafts({storage,upload:()=>pending,changed:()=>{},uuid:()=> 'draft'});
  const adding=drafts.add('a',new File([png],'pixel.png',{type:'image/png'}));
  assert.equal(drafts.list('a')[0].pending,true);drafts.remove('a','draft');complete(image);await adding;
  assert.equal(drafts.list('a').length,0);
  const ready=createImageDrafts({storage,upload:async()=>image,changed:()=>{}});
  await ready.add('a',new File([png],'pixel.png',{type:'image/png'}));
  const restored=createImageDrafts({storage,upload:async()=>image,changed:()=>{}});
  assert.equal(restored.list('a')[0].id,image.id);assert.equal(restored.list('b').length,0);
  assert.ok(!values.get('mimi-images:a').includes('base64'));
  restored.clear('a',[image.id]);assert.equal(restored.list('a').length,0);
});
