import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { AtomicJsonStore } from '../core/state-file.js';
import { sanitizeSensitiveData } from '../core/data-sanitizer.js';
import { notificationText } from '../daemon/notification-content.js';

const readSchema = z.object({ version:z.literal(1), read:z.array(z.string()) });
const legacyReads = z.object({through:z.number().int().nonnegative(),read:z.array(z.number().int().positive())});
const visible = "t.profile_id = 'owner' AND o.status != 'archived'";
const joined = 'FROM outbox o JOIN tasks t ON t.id = o.task_id';
type Row = { run_id:string|null; seq:number; id:string; task_id:string; session_key:string|null; payload_json:string; channel:string; status:string; created_at:string };

/** Read-only projection of Outbox. Only UI read receipts live in a separate atomic file. */
export class WebNotifications {
  private readonly receipts;
  constructor(private readonly database: string, receiptsFile: string) {
    this.receipts = new AtomicJsonStore(receiptsFile, { defaultValue: () => ({version:1 as const,read:[] as string[]}), decode:value => {
      const current=readSchema.safeParse(value); if(current.success)return current.data;
      const legacy=legacyReads.parse(value);
      return {version:1 as const,read:this.query(db=>(db.prepare('SELECT id FROM outbox WHERE rowid <= ? OR rowid IN (SELECT value FROM json_each(?))').all(legacy.through,JSON.stringify(legacy.read))).map(row=>String(row.id)),[] as string[])};
    }, recoverCorrupt:false, preserveSchemaMismatch:true });
  }
  private query<T>(read: (db:DatabaseSync)=>T, empty:T): T {
    if(!existsSync(this.database)) return empty;
    const db = new DatabaseSync(this.database,{readOnly:true,timeout:500});
    try { return read(db); } finally { db.close(); }
  }
  private item(row:Row, receipts:z.infer<typeof readSchema>, full=false) {
    let text:string;
    try { text=notificationText(sanitizeSensitiveData(JSON.parse(row.payload_json))); }
    catch { text='这条通知的内容无法读取，请检查运行记录。'; }
    return {id:row.id, sequence:row.seq, taskId:row.task_id, sessionId:row.session_key, runId:row.run_id, channel:row.channel,
      status:row.status, createdAt:row.created_at, read:receipts.read.includes(row.id),
      text:full?text:undefined, preview:text.replace(/\s+/g,' ').slice(0,180)};
  }
  async list(before?:number, limit=40) {
    limit = Math.min(100,Math.max(1,Math.trunc(limit)));
    const receipts=await this.receipts.read();
    return this.query(db => {
      const rows = db.prepare(`SELECT o.rowid AS seq, o.*, t.session_key, (SELECT r.id FROM runs r WHERE r.task_id=t.id ORDER BY r.attempt_no DESC LIMIT 1) AS run_id ${joined} WHERE ${visible} AND o.rowid < ? ORDER BY o.rowid DESC LIMIT ?`).all(before ?? Number.MAX_SAFE_INTEGER,Math.min(100,Math.max(1,limit))+1) as Row[];
      const count=db.prepare(`SELECT COUNT(*) AS count ${joined} WHERE ${visible} AND o.id NOT IN (SELECT value FROM json_each(?))`).get(JSON.stringify(receipts.read))!;
      const latest=db.prepare(`SELECT MAX(o.rowid) AS latest ${joined} WHERE ${visible}`).get()!;
      const more=rows.length>limit; if(more)rows.pop();
      return {items:rows.map(row=>this.item(row,receipts)), unreadCount:Number(count.count),latest:Number(latest.latest??0),nextBefore:more?rows.at(-1)!.seq:null};
    },{items:[],unreadCount:0,latest:0,nextBefore:null});
  }
  async detail(id:string) {
    const receipts=await this.receipts.read();
    return this.query(db=>{const row=db.prepare(`SELECT o.rowid AS seq, o.*, t.session_key, (SELECT r.id FROM runs r WHERE r.task_id=t.id ORDER BY r.attempt_no DESC LIMIT 1) AS run_id ${joined} WHERE ${visible} AND o.id = ?`).get(id) as Row|undefined;return row?this.item(row,receipts,true):null;},null);
  }
  async markRead(raw:unknown) {
    const value=z.union([z.object({id:z.string().min(1).max(200)}).strict(),z.object({through:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).strict()]).parse(raw);
    if('id' in value) {
      const item=await this.detail(value.id);
      if(!item)throw new Error('通知不存在');
      await this.receipts.update(state=>{if(!state.read.includes(item.id)) state.read.push(item.id);});
    } else {
      const ids=this.query(db=>(db.prepare(`SELECT o.id ${joined} WHERE ${visible} AND o.rowid <= ?`).all(value.through)).map(row=>String(row.id)),[] as string[]);
      await this.receipts.update(state=>{state.read=[...new Set([...state.read,...ids])];});
    }
    return {ok:true};
  }
}
