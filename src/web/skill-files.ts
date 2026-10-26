import { createHash, randomUUID } from 'node:crypto';
import { withExclusiveFileLock } from '../core/state-file.js';
import { constants } from 'node:fs';
import { open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Skill } from '../extensions/skills.js';

/** Resolve only resources belonging to a discovered skill, including nested symlinks. */
export async function skillResource(skill: Pick<Skill, 'root'>, relative = '', offset = 0) {
  const root = await realpath(skill.root);
  const requested = path.resolve(root, relative);
  const contained = (file: string) => file === root || file.startsWith(root + path.sep);
  if (!contained(requested)) throw new Error('文件不在此 Skill 目录内');
  const file = await realpath(requested);
  if (!contained(file)) throw new Error('文件链接指向 Skill 目录之外');
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (stat.isDirectory()) {
      const entries = (await readdir(file, { withFileTypes: true })).sort((a,b) => Number(b.isDirectory())-Number(a.isDirectory()) || a.name.localeCompare(b.name));
      return { kind: 'directory' as const, path: relative, entries: entries.slice(offset,offset+500).map(entry => ({ name: entry.name, path: path.posix.join(relative,entry.name), directory: entry.isDirectory(), link: entry.isSymbolicLink() })), nextOffset: entries.length > offset+500 ? offset+500 : undefined };
    }
    if (!stat.isFile()) throw new Error('仅支持普通文件');
    const buffer = Buffer.alloc(Math.min(256_000,Math.max(0,stat.size-offset)));
    const { bytesRead } = await handle.read(buffer,0,buffer.length,offset);
    const bytes = buffer.subarray(0,bytesRead);
    let binary = bytes.includes(0);
    // Keep complete UTF-8 characters between pages.
    let length = bytesRead;
    if (!binary && offset+bytesRead < stat.size) {
      let start = bytesRead-1;
      while(start >= 0 && (bytes[start]! & 0xc0) === 0x80) start--;
      if(start >= 0) { const lead=bytes[start]!; const width=lead<0x80?1:lead<0xe0?2:lead<0xf0?3:4; if(start+width>bytesRead)length=start; }
    }
    if (!binary) {
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0,length)); }
      catch { binary = true; length = bytesRead; }
    }
    return { kind: 'file' as const, path: relative, size: stat.size, binary, revision: offset === 0 && bytesRead === stat.size ? createHash('sha256').update(bytes).digest('hex') : undefined,
      content: binary ? bytes.toString('hex').match(/.{1,32}/g)?.join('\n') ?? '' : bytes.subarray(0,length).toString('utf8'),
      nextOffset: offset+length < stat.size ? offset+length : undefined };
  } finally { await handle.close(); }
}

/** Edit one complete UTF-8 resource with optimistic concurrency and atomic replacement. */
export async function saveSkillResource(skill: Pick<Skill, 'root'>, relative: string, content: string, revision: string) {
  const root = await realpath(skill.root), file = await realpath(path.resolve(root, relative));
  if (!file.startsWith(root + path.sep)) throw new Error('文件链接指向 Skill 目录之外');
  if (Buffer.byteLength(content) > 200_000) throw new Error('在线编辑上限为 200 KB');
  await withExclusiveFileLock(file, async () => {
    const current = await skillResource(skill, relative);
    if (current.kind !== 'file' || current.binary || !current.revision) throw new Error('仅支持完整文本文件');
    if (current.revision !== revision) throw new Error('文件已变化，请重新读取后合并');
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const mode = (await handle.stat()).mode & 0o777; await handle.close();
    try { await writeFile(temporary, content, { mode }); await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
  });
  return skillResource(skill, relative);
}
