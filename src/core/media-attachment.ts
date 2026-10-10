import { createHash } from 'node:crypto';
import { z } from 'zod';

export const MEDIA_MAX_BYTES = 100 * 1024 * 1024;
export const mediaTypes: Record<string,string> = {mp3:'audio/mpeg',wav:'audio/wav',m4a:'audio/mp4',oga:'audio/ogg',flac:'audio/flac',weba:'audio/webm',mp4:'video/mp4',webm:'video/webm',mov:'video/quicktime',file:'application/octet-stream'};
export const mediaSchema = z.object({
  id:z.string().regex(/^[a-f0-9]{64}\.(mp3|wav|m4a|oga|flac|weba|mp4|webm|mov|file)$/),
  kind:z.enum(['audio','video','file']),mediaType:z.string(),bytes:z.number().int().positive().max(MEDIA_MAX_BYTES),
  name:z.string().min(1).max(255).optional(),
  duration:z.number().nonnegative().max(3600).optional(),transcript:z.string().max(20000).optional(),
  playbackId:z.string().regex(/^[a-f0-9]{64}\.wav$/).optional(),
  frames:z.array(z.string().regex(/^[a-f0-9]{64}\.jpg$/)).max(8).optional(),
});
export type MediaAttachment = z.infer<typeof mediaSchema>;
export function mediaIds(value:unknown):string[] {
  if(value===undefined)return [];
  return z.array(mediaSchema.shape.id).max(8).parse(value);
}
export function mediaMime(id:string):string {
  mediaSchema.shape.id.parse(id);return mediaTypes[id.split('.').at(-1)!]!;
}
export function mediaAttachment(data:Buffer,type:string):MediaAttachment {
  type=({'audio/x-wav':'audio/wav','audio/x-m4a':'audio/mp4','audio/x-flac':'audio/flac'} as Record<string,string>)[type]||type;
  const ext=Object.keys(mediaTypes).find(key=>mediaTypes[key]===type);
  if(!ext || ext==='file')throw new Error('支持 MP3、WAV、M4A、OGG、FLAC、WebM、MP4、MOV');
  if(!data.length||data.length>MEDIA_MAX_BYTES)throw new Error('媒体不能为空或超过 100MB');
  const head=data.subarray(0,16);
  const valid=ext==='wav'?head.toString('ascii',0,4)==='RIFF'&&head.toString('ascii',8,12)==='WAVE'
    : ext==='mp3'?head.toString('ascii',0,3)==='ID3'||(data[0]===255&&(data[1]!&224)===224)
    : ext==='oga'?head.toString('ascii',0,4)==='OggS'
    : ext==='flac'?head.toString('ascii',0,4)==='fLaC'
    : ext==='webm'||ext==='weba'?head.subarray(0,4).equals(Buffer.from('1a45dfa3','hex'))
    : head.toString('ascii',4,8)==='ftyp';
  if(!valid)throw new Error('媒体内容与声明格式不符');
  return {id:`${createHash('sha256').update(data).digest('hex')}.${ext}`,kind:type.startsWith('audio/')?'audio':'video',mediaType:type,bytes:data.length};
}
