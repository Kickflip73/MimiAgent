import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveFile, readMedia, inputWithMedia } from '../src/runtime/media-input.js';
import { FileSession } from '../src/core/session.js';
// @ts-expect-error Browser module.
import { inlineMarkup } from '../src/web/assets/inline.js';
const esc=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
test('uploaded Markdown survives session reload and supplies bounded readable content without base64',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'mimi-files-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const data=Buffer.from('# 需求\n验收码：MIMI-FILE-42');
 const ref=await saveFile(root,data,'需求.md');
 assert.equal(ref.kind,'file');assert.equal(ref.name,'需求.md');assert.deepEqual((await readMedia(root,ref.id)).data,data);
 const input=await inputWithMedia('请总结','请总结',[ref],root) as any[];
 assert.match(input[0].content.at(-1).text,/MIMI-FILE-42/);
 const session=new FileSession(path.join(root,'sessions'),'files');await session.addItems(input);
 const restored=await new FileSession(path.join(root,'sessions'),'files').getItems() as any[];
 assert.deepEqual(restored[0].mediaAttachments,[ref]);assert.equal(restored[0].displayText,'请总结');
 await assert.rejects(saveFile(root,data,'../secret.md'));await assert.rejects(readMedia(root,'../secret'));
});
test('inline links include bare and nested URLs, preserve code, and escape unsafe markup',()=>{
 const render=(s:string)=>inlineMarkup(s,esc);
 assert.match(render('链接：https://example.com/a'),/<a href="https:\/\/example.com\/a"/);
 assert.match(render('[[https://example.com/a](https://example.com/a) ](https://example.com/a )'),/<a href=/);
 assert.equal(render('`https://example.com/a`'),'<code>https://example.com/a</code>');
 assert.ok(!render('[x](javascript:alert(1))').includes('<a'));
 assert.ok(!render('<img src=x onerror=alert(1)>').includes('<img'));
});

test('active replay keeps user attachments but never replays the same process from snapshot too',async()=>{
 // @ts-expect-error Browser module.
 const {replayHistory}=await import('../src/web/assets/execution.js');
 const items=[{role:'assistant',content:'older'},{role:'user',content:'work',mediaAttachments:[{kind:'file',name:'a.md'}],execution:{status:'unknown',steps:[{}]}},{role:'assistant',content:'partial'}];
 const history=replayHistory(items);assert.equal(history.length,2);assert.deepEqual(history[1].mediaAttachments,items[1]!.mediaAttachments);assert.equal(history[1].execution,undefined);assert.ok(items[1]!.execution);
});
