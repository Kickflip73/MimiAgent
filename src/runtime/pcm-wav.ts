import type { FileHandle } from 'node:fs/promises';

const MAX_WAV_CHUNKS = 4_096;

export interface PcmWavMetadata {
  durationMs: number;
  sampleRate: number;
  channels: 1 | 2;
  dataBytes: number;
}

async function readExactly(
  handle: FileHandle,
  position: number,
  bytes: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(bytes);
  const result = await handle.read(buffer, 0, bytes, position);
  if (result.bytesRead !== bytes) throw new Error('PCM WAV truncated while reading chunk metadata');
  return buffer;
}

/** Parses the deliberately narrow PCM16 WAV ingress contract from an already-open file. */
export async function parsePcm16Wav(
  handle: FileHandle,
  expectedBytes: number,
): Promise<PcmWavMetadata> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 44) {
    throw new Error('PCM WAV size is invalid');
  }
  const info = await handle.stat();
  if (!info.isFile() || info.size !== expectedBytes) {
    throw new Error('PCM WAV size does not match the staged artifact');
  }
  const header = await readExactly(handle, 0, 12);
  if (header.toString('ascii', 0, 4) !== 'RIFF'
    || header.toString('ascii', 8, 12) !== 'WAVE'
    || header.readUInt32LE(4) + 8 !== expectedBytes) {
    throw new Error('PCM WAV requires an exact RIFF/WAVE container');
  }

  let offset = 12;
  let format: {
    sampleRate: number;
    channels: 1 | 2;
    byteRate: number;
    blockAlign: number;
  } | undefined;
  let dataBytes: number | undefined;
  let chunks = 0;
  while (offset < expectedBytes && chunks < MAX_WAV_CHUNKS) {
    const chunk = await readExactly(handle, offset, 8);
    const kind = chunk.toString('ascii', 0, 4);
    const length = chunk.readUInt32LE(4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > expectedBytes) throw new Error('PCM WAV chunk exceeds the RIFF boundary');
    if (kind === 'fmt ') {
      if (format || length !== 16) throw new Error('PCM WAV requires exactly one 16-byte fmt chunk');
      const value = await readExactly(handle, dataStart, 16);
      const encoding = value.readUInt16LE(0);
      const rawChannels = value.readUInt16LE(2);
      const sampleRate = value.readUInt32LE(4);
      const byteRate = value.readUInt32LE(8);
      const blockAlign = value.readUInt16LE(12);
      const bitsPerSample = value.readUInt16LE(14);
      if (encoding !== 1 || (rawChannels !== 1 && rawChannels !== 2)
        || sampleRate < 8_000 || sampleRate > 96_000 || bitsPerSample !== 16) {
        throw new Error('only mono/stereo PCM16 WAV at 8kHz-96kHz is supported');
      }
      const channels = rawChannels as 1 | 2;
      const expectedBlockAlign = channels * 2;
      if (blockAlign !== expectedBlockAlign || byteRate !== sampleRate * expectedBlockAlign) {
        throw new Error('PCM WAV byteRate/blockAlign is inconsistent with its format');
      }
      format = { sampleRate, channels, byteRate, blockAlign };
    } else if (kind === 'data') {
      if (dataBytes !== undefined || !format || length === 0) {
        throw new Error('PCM WAV requires one non-empty data chunk after fmt');
      }
      dataBytes = length;
    }
    offset = dataEnd + (length % 2);
    chunks += 1;
  }
  if (offset !== expectedBytes || chunks >= MAX_WAV_CHUNKS || !format || dataBytes === undefined) {
    throw new Error('PCM WAV has incomplete or excessive chunk metadata');
  }
  if (dataBytes % format.blockAlign !== 0) {
    throw new Error('PCM WAV data is not aligned to complete frames');
  }
  const durationMs = Math.ceil(dataBytes * 1_000 / format.byteRate);
  if (!Number.isSafeInteger(durationMs) || durationMs < 1) {
    throw new Error('PCM WAV duration is invalid');
  }
  return {
    durationMs,
    sampleRate: format.sampleRate,
    channels: format.channels,
    dataBytes,
  };
}
