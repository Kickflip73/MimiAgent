import { createHash } from 'node:crypto';

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_MAX_COUNT = 8;
export const IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;
const formats: Record<string, string> = {'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp'};
export interface ImageAttachment { id: string; mediaType: string; bytes: number }

export function imageMediaType(id: string): string {
  if (!/^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(id)) throw new Error('无效的图片标识');
  return Object.keys(formats).find(type => formats[type] === id.split('.').at(-1))!;
}
export function imageAttachment(data: Buffer, mediaType: string): ImageAttachment {
  if (!formats[mediaType]) throw new Error('仅支持 PNG、JPEG、GIF 和 WebP 图片');
  if (!data.length || data.length > IMAGE_MAX_BYTES) throw new Error('图片不能为空或超过 10MB');
  const matches = mediaType === 'image/png' ? data.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))
    : mediaType === 'image/jpeg' ? data[0]===255 && data[1]===216 && data[2]===255
    : mediaType === 'image/gif' ? /^GIF8[79]a$/.test(data.subarray(0,6).toString())
    : data.subarray(0,4).toString()==='RIFF' && data.subarray(8,12).toString()==='WEBP';
  if (!matches) throw new Error('图片内容与格式不符');
  return {id:`${createHash('sha256').update(data).digest('hex')}.${formats[mediaType]}`,mediaType,bytes:data.length};
}
export function imageIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > IMAGE_MAX_COUNT) throw new Error('每条消息最多 8 张图片');
  return value.map(id => { if (typeof id !== 'string') throw new Error('无效的图片标识'); imageMediaType(id); return id; });
}
/** Small display reference only; binary data never belongs in canonical history. */
export function inlineImageAttachment(value: unknown): ImageAttachment | undefined {
  if (typeof value !== 'string') return;
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) return;
  try { return imageAttachment(Buffer.from(match[2]!, 'base64'),match[1]!); } catch { return; }
}
