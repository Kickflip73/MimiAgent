import { constants } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { imageAttachment, imageMediaType, IMAGE_MAX_BYTES, type ImageAttachment } from '../core/image-attachment.js';

export async function saveWebImage(root: string, data: Buffer, mediaType: string): Promise<ImageAttachment> {
  const image = imageAttachment(data, mediaType);
  await mkdir(root, {recursive:true,mode:0o700});
  const destination = path.join(root,image.id), temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
    await rename(temporary,destination);
  } finally { await rm(temporary,{force:true}); }
  return image;
}
export async function readWebImage(roots: string[], id: string): Promise<{data:Buffer;mediaType:string}> {
  const mediaType = imageMediaType(id);
  for (const [index,root] of roots.entries()) {
    let file;
    try {
      // Daemon snapshots use the original content hash without a filename extension.
      file = await open(path.join(root,index===0?id:id.split('.')[0]!),constants.O_RDONLY|constants.O_NOFOLLOW);
      const info = await file.stat();
      if(!info.isFile() || info.size>IMAGE_MAX_BYTES) throw new Error('图片文件无效');
      const data = await file.readFile();
      if(imageAttachment(data,mediaType).id !== id) throw new Error('图片校验失败');
      return {data,mediaType};
    } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error; }
    finally { await file?.close(); }
  }
  throw Object.assign(new Error('图片已不存在'),{status:404});
}
