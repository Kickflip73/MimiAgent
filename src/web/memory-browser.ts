import { existsSync } from 'node:fs';
import path from 'node:path';
import { privateMemoryLayout } from '../extensions/memory/layout.js';
import { SqliteMemoryCatalog } from '../extensions/memory/sqlite-catalog.js';
import { stableDirectoryId, type MemoryHit } from '../core/memory.js';

/** Read saved wiki and L0 evidence without joining the mutable Agent/session lane. */
export function memoryEvidence(dataRoot:string, workspaceRoot:string):MemoryHit[] {
  const sources=[{file:privateMemoryLayout(dataRoot,'owner').databaseFile,scope:'private' as const,profile:'owner'}, {file:path.join(dataRoot,'memory','workspaces',stableDirectoryId(workspaceRoot),'memory.db'),scope:'workspace' as const,profile:undefined}];
  return sources.flatMap(({file,scope,profile})=>{
    if(!existsSync(file))return [];
    let catalog:SqliteMemoryCatalog|undefined;
    try { catalog=new SqliteMemoryCatalog(file,scope,profile,{readOnly:true,readOnlySnapshotWal:true});return [...catalog.list({documentTypes:['wiki'],order:'recent',limit:100}),...catalog.list({documentTypes:['source','episode'],status:'all',order:'recent',limit:200})]; }
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
    finally {catalog?.close();}
  });
}

/** Detail reads use the same saved catalog as the list, never a busy Agent mutation lane. */
export function readMemoryEvidence(dataRoot: string, workspaceRoot: string, scope: 'private' | 'workspace', id: string) {
  const profileId = scope === 'private' ? 'owner' : undefined;
  const file = scope === 'private' ? privateMemoryLayout(dataRoot, 'owner').databaseFile
    : path.join(dataRoot, 'memory', 'workspaces', stableDirectoryId(workspaceRoot), 'memory.db');
  if (!existsSync(file)) return undefined;
  const catalog = new SqliteMemoryCatalog(file, scope, profileId, { readOnly: true, readOnlySnapshotWal: true });
  try { return catalog.readDocument({ scope, id, ...(profileId ? { profileId } : {}) }); }
  finally { catalog.close(); }
}
