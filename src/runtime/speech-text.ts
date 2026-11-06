/** Conservative, deterministic spoken-text preparation; never rewrites the transcript. */
export function prepareSpeechText(source: string, language: string = 'auto') {
  const zh = language === 'zh' || (language === 'auto' && /[\u3400-\u9fff]/u.test(source));
  const warnings: string[] = [];
  let text = source.replace(/[０-９Ａ-Ｚａ-ｚ％]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\r\n?/g, '\n');
  text = text.replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g, () => {
    warnings.push('代码块已用提示替代；需要朗读代码时请选择原文。');
    return zh ? '\n这里有一段代码，请查看原文。\n' : '\nA code block is available in the original text.\n';
  });
  const lines = text.split('\n'), output: string[] = [];
  const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map(s => s.trim());
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? '')) {
      const headers = cells(lines[i]!); i += 2;
      while (i < lines.length && lines[i]!.includes('|')) {
        const row = cells(lines[i]!);
        output.push(row.map((value, n) => `${headers[n] || (zh ? '项目' : 'Item')}: ${value}`).join(zh ? '；' : '; ') + (zh ? '。' : '.'));
        i++;
      }
      i--; continue;
    }
    output.push(lines[i]!);
  }
  text = output.join('\n')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/[^\s<>]+/g, () => { warnings.push('裸链接已省略地址。'); return zh ? '链接见原文' : 'link in the original text'; })
    .replace(/<[^>]*>/g, '')
    .replace(/^[ \t]*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/^[ \t]*[-=]{3,}[ \t]*$/gm, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\u200b-\u200f\uFE0F]/g, '');
  if (zh) {
    const digits = (s: string) => [...s].map(c => '零一二三四五六七八九'[Number(c)]).join('');
    const number = (s: string): string => {
      if (s.includes('.')) { const [a, b] = s.split('.'); return number(a!) + '点' + digits(b!); }
      if (s.length > 8 || /^0\d/.test(s)) return digits(s);
      const n = Number(s);
      if (n >= 10000) return number(String(Math.floor(n / 10000))) + '万' + (n % 10000 ? (n % 10000 < 1000 ? '零' : '') + number(String(n % 10000)) : '');
      if (n < 10) return digits(s);
      return [...String(n)].map((c, i, a) => c === '0' ? (a.slice(i + 1).some(x => x !== '0') && a[i - 1] !== '0' ? '零' : '') : digits(c) + ['', '十', '百', '千'][a.length - i - 1]).join('').replace(/^一十/, '十');
    };
    text = text.replace(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, (_, y, m, d) => `${digits(y)}年${number(String(Number(m)))}月${number(String(Number(d)))}日`)
      .replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h, m) => `${number(String(Number(h)))}点${m === '00' ? '整' : number(String(Number(m))) + '分'}`)
      .replace(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g, s => s.replaceAll(',', ''))
      .replace(/(\d+(?:\.\d+)?)\s*%/g, (_, n) => '百分之' + number(n))
      .replace(/[$¥￥]\s*(\d+(?:\.\d+)?)/g, (s, n) => number(n) + (s.startsWith('$') ? '美元' : '元'))
      .replace(/(\d+(?:\.\d+)?)\s*(GB|MB|KB|ms|kg|km|Hz)\b/g, (_, n, unit) => number(n) + ({ GB: '吉字节', MB: '兆字节', KB: '千字节', ms: '毫秒', kg: '千克', km: '千米', Hz: '赫兹' } as Record<string,string>)[unit])
      .replace(/\b(?:MimiAgent|Mimi|TTS|API|CPU|GPU)\b/g, s => ({ MimiAgent: '咪咪助手', Mimi: '咪咪', TTS: '语音合成', API: '接口', CPU: '中央处理器', GPU: '图形处理器' } as Record<string,string>)[s]!)
      .replace(/(?<![A-Za-z\d.])\d+(?:\.\d+)?(?![A-Za-z\d.])/g, number)
      .replace(/\s*[→⇒]\s*/g, '，然后，').replace(/[≤≥]/g, s => s === '≤' ? '小于等于' : '大于等于');
  } else {
    text = text.replace(/(\d+(?:\.\d+)?)%/g, '$1 percent').replace(/\s*[→⇒]\s*/g, ', then, ');
  }
  text = text.replace(/[|]/g, '，').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (/[A-Za-z]/.test(text) && zh) warnings.push('保留英文专名；如发音不佳，可由 Agent 改写阅读稿，避免自动猜测翻译。');
  return { text, language: zh ? 'zh' : language === 'auto' ? 'en' : language, warnings: [...new Set(warnings)] };
}
