import { constants } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AgentInputItem } from '@openai/agents';
import { AtomicJsonStore } from '../core/state-file.js';
import { mediaAttachment, mediaMime, mediaSchema, MEDIA_MAX_BYTES, type MediaAttachment } from '../core/media-attachment.js';
import { inputWithAttachments, stageAttachments } from './attachments.js';

export function mediaRecord(root:string,id:string) {
  mediaMime(id);
  return new AtomicJsonStore<MediaAttachment|null>(path.join(root,`${id}.json`),{defaultValue:()=>null,decode:value=>value===null?null:mediaSchema.parse(value)});
}
export async function saveMedia(root:string,data:Buffer,type:string):Promise<MediaAttachment> {
  const ref=mediaAttachment(data,type);await mkdir(root,{recursive:true,mode:0o700});
  const temp=path.join(root,`${ref.id}.${randomUUID()}.tmp`);
  try {const file=await open(temp,'wx',0o600);try{await file.writeFile(data);await file.sync();}finally{await file.close();}await rename(temp,path.join(root,ref.id));}
  finally{await rm(temp,{force:true});}
  return ref;
}
export async function readMedia(root:string,id:string):Promise<{data:Buffer;mediaType:string}> {
  const type=mediaMime(id),file=await open(path.join(root,id),constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const info=await file.stat();if(!info.isFile()||info.size>MEDIA_MAX_BYTES)throw new Error('媒体文件无效');
    const data=await file.readFile();if(mediaAttachment(data,type).id!==id)throw new Error('媒体校验失败');return {data,mediaType:type};
  }finally{await file.close();}
}
export async function inputWithMedia(input:string|AgentInputItem[],text:string,media:MediaAttachment[],root:string):Promise<string|AgentInputItem[]> {
  if(!media.length)return input;
  const result=typeof input==='string'?[{role:'user',content:[{type:'input_text',text:input}]}]:structuredClone(input);
  const user=result.find(item=>'role' in item&&item.role==='user') as any;
  if(!user||!Array.isArray(user.content))throw new Error('多媒体输入缺少用户消息');
  for(const ref of media) {
    mediaSchema.parse(ref);
    if(ref.kind==='audio') {
      if(!ref.transcript?.trim())throw new Error('语音尚未识别，请完成识别或补充文字');
      user.content.push({type:'input_text',text:`[语音转写，可能有识别误差]\n${ref.transcript}`});
    } else {
      const frames=ref.frames||[];
      if(!frames.length)throw new Error('视频尚未准备完成');
      user.content.push({type:'input_text',text:`[视频 ${ref.duration?.toFixed(1)||'?'} 秒；以下 ${frames.length} 张为均匀采样画面，不代表逐帧完整理解，也不包含声音。]`});
      const staged=await stageAttachments(frames.map(id=>({path:id,kind:'image' as const})),path.join(root,'frames'),path.join(root,'frame-snapshots'));
      const images=await inputWithAttachments('',staged) as any[];
      if(images[0])user.content.push(...images[0].content);
    }
  }
  user.mediaAttachments=media;user.displayText=text;
  return result as AgentInputItem[];
}
