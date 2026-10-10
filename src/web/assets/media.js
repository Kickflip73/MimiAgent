export const mediaUrl=id=>/^[a-f0-9]{64}\.(mp3|wav|m4a|oga|flac|weba|mp4|webm|mov|file)$/.test(id)?`/api/media?id=${id}`:'';
export const mediaTime=seconds=>{const n=Math.max(0,Math.floor(Number(seconds)||0));return `${Math.floor(n/60)}:${String(n%60).padStart(2,'0')}`;};
export function mediaMarkup(ref,esc) {
  const src=ref.src||mediaUrl(ref.playbackId||ref.id);if(!src)return '';
  if(ref.kind==='file')return `<a class="file-attachment" href="${esc(src)}" download="${esc(ref.name||'附件')}"><span aria-hidden="true">↧</span><span><strong>${esc(ref.name||'文件附件')}</strong><small>${Math.ceil((ref.bytes||0)/1024)} KB</small></span></a>`;
  if(ref.kind==='video')return `<figure class="media-video"><video controls playsinline preload="metadata" src="${esc(src)}"></video><figcaption>视频${ref.duration?` · ${mediaTime(ref.duration)}`:''}</figcaption></figure>`;
  return `<div class="voice-message"><div class="voice-player"><audio preload="metadata" src="${esc(src)}"></audio><button type="button" class="voice-play" data-audio-play aria-label="播放语音"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 9 6-9 6z"/></svg></button><span class="voice-label">语音</span><input type="range" data-audio-seek aria-label="语音播放进度" value="0" min="0" max="100" step="0.1"><time data-audio-time>${mediaTime(ref.duration)}</time></div>${ref.transcript?`<p class="voice-transcript">${esc(ref.transcript)}</p>`:''}</div>`;
}
export function bindMediaPlayers(root) {
  root.addEventListener('click',event=>{
    const button=event.target.closest('[data-audio-play]');if(!button)return;
    const player=button.closest('.voice-player'),audio=player.querySelector('audio');
    if(audio.paused){root.querySelectorAll('audio,video').forEach(other=>{if(other!==audio)other.pause();});audio.play().catch(()=>{button.title='无法播放，请检查文件格式';});}
    else audio.pause();
  });
  for(const name of ['play','pause','ended','timeupdate','loadedmetadata','error'])root.addEventListener(name,event=>{
    const audio=event.target;if(audio.tagName!=='AUDIO')return;
    const player=audio.closest('.voice-player');if(!player)return;
    const playing=!audio.paused&&!audio.ended,button=player.querySelector('button');
    button.setAttribute('aria-label',playing?'暂停语音':'播放语音');button.classList.toggle('is-playing',playing);
    button.innerHTML=playing?'<svg viewBox="0 0 20 20"><path d="M5 4h4v12H5zm7 0h4v12h-4z"/></svg>':'<svg viewBox="0 0 20 20"><path d="m7 4 9 6-9 6z"/></svg>';
    if(Number.isFinite(audio.duration)){player.querySelector('time').textContent=`${mediaTime(audio.currentTime)} / ${mediaTime(audio.duration)}`;player.querySelector('input').value=String(audio.currentTime/audio.duration*100);}
    if(name==='error'){button.title='无法播放此音频，请重新选择文件';}
  },true);
  root.addEventListener('input',event=>{if(!event.target.matches('[data-audio-seek]'))return;const audio=event.target.closest('.voice-player').querySelector('audio');if(Number.isFinite(audio.duration))audio.currentTime=Number(event.target.value)/100*audio.duration;});
}
export function createMediaDrafts({storage,upload,prepare,changed}) {
  const sessions=new Map();
  const list=session=>{if(!sessions.has(session)){let values=[];try{values=JSON.parse(storage.getItem(`mimi-media:${session}`)||'[]');}catch{}sessions.set(session,Array.isArray(values)?values.filter(i=>mediaUrl(i.id)).map(i=>({...i,pending:false,src:mediaUrl(i.playbackId||i.id)})):[]);}return sessions.get(session);};
  const save=session=>{storage.setItem(`mimi-media:${session}`,JSON.stringify(list(session).filter(i=>i.id).map(({src,pending,...i})=>i)));changed(session);};
  async function recognize(session,item) {
    if(item.pending)return;
    item.pending=true;item.error='';changed(session);
    try{const result=await prepare(item.id);if(!list(session).includes(item))return;Object.assign(item,result,{ready:true,src:mediaUrl(result.playbackId||result.id)});}
    catch(e){item.error=e.message;}
    finally{item.pending=false;if(list(session).includes(item))save(session);}
  }
  return {list,
    async add(session,file){
      if(file.size>100*1024*1024||!file.size)throw new Error('媒体不能为空或超过 100MB');
      if(list(session).length>=8)throw new Error('每条消息最多 8 个附件');
      const item={key:crypto.randomUUID(),name:file.name,kind:file.type.startsWith('video/')?'video':file.type.startsWith('audio/')?'audio':'file',bytes:file.size,src:URL.createObjectURL(file),pending:true};list(session).push(item);changed(session);
      try{const result=await upload(file);if(!list(session).includes(item))return;URL.revokeObjectURL(item.src);Object.assign(item,result,{src:mediaUrl(result.id),pending:false});save(session);await recognize(session,item);}
      catch(e){item.pending=false;item.error=e.message;changed(session);}
    },
    retry(session,key){const item=list(session).find(i=>(i.key||i.id)===key);if(item?.id)return recognize(session,item);},
    remove(session,key){const items=list(session),i=items.findIndex(v=>(v.key||v.id)===key);if(i<0)return;const [item]=items.splice(i,1);if(item.src?.startsWith('blob:'))URL.revokeObjectURL(item.src);save(session);},
    clear(session,ids){for(const item of [...list(session)])if(!ids||ids.includes(item.id))this.remove(session,item.key||item.id);},
  };
}
/** Recognize links only; never execute model-provided markup or scripts. */
export function outputMedia(text,session) {
  const refs=[],seen=new Set();
  text=text.replace(/^```[^\n]*\n[\s\S]*?(?:^```\s*$|$(?![\s\S]))/gm,'');
  const pattern=/!?\[[^\]]*\]\(([^\n)]+)\)|`((?:\/|file:\/\/)[^`\n]+)`/g;
  let match;while((match=pattern.exec(text))&&refs.length<12){
    const raw=(match[1]||match[2]).trim();
    const ext=/\.(png|jpe?g|gif|webp|mp3|wav|m4a|ogg|flac|mp4|webm|mov|file)(?:[?#].*)?$/i.exec(raw)?.[1]?.toLowerCase();
    if(!ext||seen.has(raw))continue;seen.add(raw);
    const remote=/^https:\/\//.test(raw);
    if(!remote&&!raw.startsWith('/')&&!raw.startsWith('file:///'))continue;
    const src=remote?raw:`/api/media/output?session=${encodeURIComponent(session)}&path=${encodeURIComponent(raw.replace(/^file:\/\//,''))}`;
    refs.push({kind:/^(png|jpe?g|gif|webp)$/.test(ext)?'image':/^(mp4|webm|mov|file)$/.test(ext)?'video':'audio',src});
  }return refs;
}
