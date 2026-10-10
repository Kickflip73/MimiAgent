/** Tokenize before escaping so generated anchors are never processed a second time. */
export function inlineMarkup(source, esc) {
  const pattern=/`([^`]+)`|\[([^\[\]]+)\]\(\s*((?:https?:\/\/|file:\/\/\/|\/)[^\n)]+?)\s*\)|\*\*([^*]+)\*\*|https?:\/\/[^\s<>\[\]"`]+/g;
  let result='',cursor=0;
  const link=(url,label)=>`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
  for(const match of String(source).matchAll(pattern)) {
    result+=esc(source.slice(cursor,match.index));cursor=match.index+match[0].length;
    const [,code,label,url,bold]=match;
    if(code!==undefined)result+=`<code>${esc(code)}</code>`;
    else if(url!==undefined)result+=/^https?:\/\//.test(url)?link(url,label):/\.(png|jpe?g|gif|webp|mp3|wav|m4a|ogg|flac|mp4|webm|mov)$/i.test(url)?`<span class="media-reference">${esc(label)}</span>`:esc(match[0]);
    else if(bold!==undefined)result+=`<strong>${inlineMarkup(bold,esc)}</strong>`;
    else {const raw=match[0],trimmed=raw.replace(/[).,;!?，。；！？”）]+$/u,'');result+=link(trimmed,trimmed)+esc(raw.slice(trimmed.length));}
  }
  return result+esc(source.slice(cursor));
}
