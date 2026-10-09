import path from 'node:path';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { runManagedCommand } from '../core/managed-process.js';
import { type MediaAttachment } from '../core/media-attachment.js';
import { mediaRecord, readMedia, saveMedia } from '../runtime/media-input.js';
import { transcribeAudio } from '../runtime/speech-input.js';
import { saveWebImage } from './images.js';

export async function mediaBinary(name:'ffmpeg'|'ffprobe'):Promise<string> {
  for(const file of [`/opt/homebrew/bin/${name}`,`/usr/local/bin/${name}`,`/usr/bin/${name}`])try{await access(file);return file;}catch{/* Next installation. */}
  throw new Error(`需要安装 ${name} 才能处理音频和视频`);
}
let preparationLane:Promise<unknown>=Promise.resolve();
const pending=new Map<string,Promise<MediaAttachment>>();
export async function prepareMedia(root:string,id:string):Promise<MediaAttachment> {
  const key=path.join(root,id);
  if(pending.has(key))return pending.get(key)!;
  if(pending.size>=8)throw new Error('媒体处理队列已满，请稍后重试');
  const job=preparationLane.then(async()=>{
    const saved=await mediaRecord(root,id).read();if(saved&&(saved.kind==='video'||saved.playbackId))return saved;
    const {data,mediaType}=await readMedia(root,id);
    let kind:'audio'|'video'=mediaType.startsWith('audio/')?'audio':'video';
    const command=await mediaBinary('ffmpeg'),probe=await mediaBinary('ffprobe');
    const info=JSON.parse((await runManagedCommand(probe,['-v','error','-protocol_whitelist','file,pipe','-show_entries','format=duration:stream=codec_type','-of','json',key],{timeoutMs:10_000})).stdout);
    if(kind==='video'&&!info.streams?.some((s:{codec_type:string})=>s.codec_type==='video')&&info.streams?.some((s:{codec_type:string})=>s.codec_type==='audio'))kind='audio';
    let duration=Number(info.format?.duration);
    if(kind==='video'&&(!Number.isFinite(duration)||duration<=0||duration>600))throw new Error('请使用时长不超过 10 分钟的有效媒体');
    if(!info.streams?.some((s:{codec_type:string})=>s.codec_type===kind))throw new Error('媒体轨道与文件类型不符');
    const directory=await mkdtemp(path.join(tmpdir(),'mimi-media-'));
    try {
      const ref:MediaAttachment={id,kind,mediaType,bytes:data.length};
      if(kind==='audio') {
        const wav=path.join(directory,'speech.wav');
        await runManagedCommand(command,['-nostdin','-v','error','-protocol_whitelist','file,pipe','-i',key,'-t','601','-vn','-ac','1','-ar','16000','-threads','2','-y',wav],{timeoutMs:25_000});
        // Browser MediaRecorder WebM commonly has no container duration. Probe the bounded decoded WAV.
        const decoded=JSON.parse((await runManagedCommand(probe,['-v','error','-show_entries','format=duration','-of','json',wav],{timeoutMs:10_000})).stdout);
        duration=Number(decoded.format?.duration);
        if(!Number.isFinite(duration)||duration<=0||duration>600)throw new Error('语音最长支持 10 分钟');
        ref.transcript=await transcribeAudio(root,wav);
        // Recorder WebM has no seekable duration. Keep a bounded PCM playback copy.
        ref.playbackId=(await saveMedia(root,await readFile(wav),'audio/wav')).id;
      } else {
        const step=Math.max(.25,duration/8);
        await runManagedCommand(command,['-nostdin','-v','error','-protocol_whitelist','file,pipe','-i',key,'-vf',`fps=1/${step},scale=960:960:force_original_aspect_ratio=decrease`,'-frames:v','8','-threads','2','-q:v','4',path.join(directory,'frame-%02d.jpg')],{timeoutMs:45_000});
        ref.frames=[];
        for(const file of (await readdir(directory)).filter(f=>f.endsWith('.jpg')).sort())ref.frames.push((await saveWebImage(path.join(root,'frames'),await readFile(path.join(directory,file)),'image/jpeg')).id);
        if(!ref.frames.length)throw new Error('无法读取视频画面');
      }
      ref.duration=duration;
      await mediaRecord(root,id).replace(ref);return ref;
    }finally{await rm(directory,{recursive:true,force:true});}
  });preparationLane=job.catch(()=>{});pending.set(key,job);
  try{return await job;}finally{pending.delete(key);}
}
