/** Bound reference audio before sending it to the independent voice service. */
export function validateVoiceSample(data: Buffer): void {
  const invalid = () => new Error('参考声音需要 1～30 秒、单声道 PCM16 WAV，请重新选择或录制');
  if (data.length < 44 || data.length > 16 * 1024 * 1024
    || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE'
    || data.readUInt32LE(4) !== data.length - 8) throw invalid();
  let rate = 0, bytes = 0, formats = 0, payloads = 0;
  for (let offset = 12; offset < data.length;) {
    if (offset + 8 > data.length) throw invalid();
    const kind = data.toString('ascii', offset, offset + 4), length = data.readUInt32LE(offset + 4);
    const start = offset + 8, end = start + length;
    if (end > data.length) throw invalid();
    if (kind === 'fmt ') {
      if (++formats !== 1 || length < 16 || data.readUInt16LE(start) !== 1
        || data.readUInt16LE(start + 2) !== 1 || data.readUInt16LE(start + 14) !== 16) throw invalid();
      rate = data.readUInt32LE(start + 4);
      if (rate < 8000 || rate > 192000 || data.readUInt32LE(start + 8) !== rate * 2
        || data.readUInt16LE(start + 12) !== 2) throw invalid();
    } else if (kind === 'data') { if (++payloads !== 1) throw invalid(); bytes = length; }
    offset = end + (length % 2);
  }
  if (!rate || bytes % 2 || bytes < rate * 2 || bytes > rate * 60) throw invalid();
}
