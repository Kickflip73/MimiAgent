import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { assertAudioSignal, transcribeAudio } from '../src/runtime/speech-input.js';
import { saveMedia, mediaRecord } from '../src/runtime/media-input.js';
import { prepareMedia } from '../src/web/media.js';
function pcm(seconds:number,amplitude=0):Buffer {
  const data=Buffer.alloc(44+Math.round(seconds*16000)*2);
  data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(16000,24);data.writeUInt32LE(32000,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(data.length-44,40);
  for(let i=44;i<data.length;i+=2)data.writeInt16LE(Math.round(Math.sin(i*.1)*amplitude),i);
  return data;
}
test('silence is rejected before recognition; quiet signal and non-silent short words are retained',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'mimi-speech-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const file=path.join(root,'silent.wav');await writeFile(file,pcm(4));
  await assert.rejects(transcribeAudio(root,file),/没有录到有效声音/);
  assert.throws(()=>assertAudioSignal(pcm(4,1)),/没有录到有效声音/);
  assert.throws(()=>assertAudioSignal(pcm(.04,3000)),/没有录到有效声音/);
  assert.doesNotThrow(()=>assertAudioSignal(pcm(.2,30)));
  assert.doesNotThrow(()=>assertAudioSignal(pcm(4,3000)));
  assert.throws(()=>assertAudioSignal(pcm(1).subarray(0,100)),/不完整/);
});
test('old cached silence cannot bypass validation and resend a hallucinated transcript',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'mimi-speech-cache-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const ref=await saveMedia(root,pcm(4),'audio/wav');
  await mediaRecord(root,ref.id).replace({...ref,transcript:'you',playbackId:ref.id,duration:4});
  await assert.rejects(prepareMedia(root,ref.id),/没有录到有效声音/);
  const audible=await saveMedia(root,pcm(.4,300),'audio/wav');
  await mediaRecord(root,audible.id).replace({...audible,transcript:'you',playbackId:audible.id,duration:.4});
  assert.equal((await prepareMedia(root,audible.id)).transcript,'you');
});
