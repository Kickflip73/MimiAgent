import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { mediaAttachment, MEDIA_MAX_BYTES } from '../core/media-attachment.js';
import { imageAttachment } from '../core/image-attachment.js';
import { assertSessionId } from '../core/session-id.js';

const types:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4','.ogg':'audio/ogg','.flac':'audio/flac','.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime'};
const inside=(root:string,file:string)=>{const relative=path.relative(root,file);return relative!==''&&!relative.startsWith('..')&&!path.isAbsolute(relative);};
/** Only media explicitly referenced by this assistant history, inside its workspace/media roots. */
export async function readOutputMedia(dataRoot:string,workspaceRoot:string,session:string,file:string):Promise<{data:Buffer;mediaType:string}> {
  assertSessionId(session);
  const type=types[path.extname(file).toLowerCase()];
  if(!path.isAbsolute(file)||!type||file.length>4096)throw new Error('无效的媒体路径');
  const resolved=await realpath(file),workspace=await realpath(workspaceRoot);
  const generated=path.resolve(dataRoot,'media');
  if(!inside(workspace,resolved)&&!inside(generated,resolved))throw new Error('媒体不在当前会话的工作区');
  if(inside(path.resolve(dataRoot),resolved)&&!inside(generated,resolved))throw new Error('不能读取运行时私有文件');
  if(path.relative(inside(generated,resolved)?generated:workspace,resolved).split(path.sep).some(part=>part.startsWith('.')||part==='node_modules'))throw new Error('不能读取隐藏或依赖目录中的媒体');
  const history=await open(path.join(dataRoot,'sessions',`${session}.json`),'r');let source;
  try{if((await history.stat()).size>32*1024*1024)throw new Error('历史文件过大');source=JSON.parse(await history.readFile('utf8'));}finally{await history.close();}
  const escaped=file.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const reference=new RegExp(`(?:^|[\\s(\x60])(?:file:\/\/)?${escaped}(?=$|[\\s)\x60])`);
  const referenced=(source.items||[]).some((item:any)=>item.role==='assistant'&&
    reference.test(typeof item.content==='string'?item.content:(item.content||[]).map((part:any)=>part.text||'').join('\n')));
  if(!referenced)throw new Error('当前回答未引用此媒体');
  const handle=await open(resolved,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const info=await handle.stat();if(!info.isFile()||info.size>MEDIA_MAX_BYTES)throw new Error('媒体文件过大或无效');const data=await handle.readFile();if(type.startsWith('image/'))imageAttachment(data,type);else mediaAttachment(data,type);return {data,mediaType:type};}finally{await handle.close();}
}
