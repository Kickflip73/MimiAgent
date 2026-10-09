export const imageUrl = id => /^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(id) ? `/api/images?id=${encodeURIComponent(id)}` : '';

/** Keep only small uploaded references in browser storage, never image base64. */
export function createImageDrafts({storage,upload,changed,uuid=()=>crypto.randomUUID()}) {
  const sessions = new Map();
  function list(session) {
    if (!sessions.has(session)) {
      let saved=[];
      try { saved=JSON.parse(storage.getItem(`mimi-images:${session}`)||'[]'); } catch { /* Empty cache. */ }
      sessions.set(session,Array.isArray(saved)?saved.filter(i=>imageUrl(i.id)).map(i=>({...i,src:imageUrl(i.id)})):[]);
    }
    return sessions.get(session);
  }
  function save(session) {
    storage.setItem(`mimi-images:${session}`,JSON.stringify(list(session).filter(i=>!i.pending).map(({id,bytes,mediaType,name})=>({id,bytes,mediaType,name}))));
    changed(session);
  }
  function remove(session, key) {
    const images=list(session), at=images.findIndex(i=>(i.key||i.id)===key);
    if(at<0)return;
    const [item]=images.splice(at,1); if(item.src?.startsWith('blob:'))URL.revokeObjectURL(item.src);
    save(session);
  }
  return {
    list, remove,
    clear(session, ids) { for(const item of [...list(session)]) if(!ids || ids.includes(item.id))remove(session,item.key||item.id); },
    async add(session,file) {
      const images=list(session);
      if(!['image/png','image/jpeg','image/gif','image/webp'].includes(file.type))throw new Error('支持 PNG、JPEG、GIF、WebP 图片');
      if(!file.size || file.size>10*1024*1024)throw new Error('每张图片不能超过 10MB');
      if(images.length>=8 || images.reduce((sum,i)=>sum+i.bytes,0)+file.size>20*1024*1024)throw new Error('最多 8 张图片，合计不超过 20MB');
      const item={key:uuid(),name:file.name||'图片',bytes:file.size,pending:true,src:URL.createObjectURL(file)};
      images.push(item);changed(session);
      try {
        const result=await upload(file);
        if(!imageUrl(result.id))throw new Error('未收到有效的图片回执');
        if(!images.includes(item))return;
        URL.revokeObjectURL(item.src);
        Object.assign(item,result,{src:imageUrl(result.id),pending:false});save(session);
      } catch(error) { remove(session,item.key);throw error; }
    },
  };
}
