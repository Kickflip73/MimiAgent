/** JSON for text-only context consumers. Native image transport is not prose. */
export function serializeTextContext(value: unknown, onImage?: (detail?: string) => void): string | undefined {
  return JSON.stringify(value, (_key, part: unknown) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return part;
    const block = part as Record<string, unknown>;
    if ((block.type !== 'input_image' && block.type !== 'image') || !block.image) return part;
    onImage?.(typeof block.detail === 'string' ? block.detail : undefined);
    const { image, ...metadata } = block;
    const reference = typeof image === 'string'
      ? (/^https?:\/\//.test(image) ? image : undefined)
      : typeof image === 'object' && image !== null
        ? (image as Record<string, unknown>).id ?? (image as Record<string, unknown>).fileId ?? (image as Record<string, unknown>).url
        : undefined;
    return { ...metadata, image: '[图片附件：编码已省略；画面内容仅以已有文字观察为依据，不可猜测]',
      ...(typeof reference === 'string' ? {reference} : {}) };
  });
}

/** Portable planning estimate, not provider billing. Image usage is independent of Base64 size.
 * Keep a nonzero vision allowance (larger for original detail); provider usage remains authoritative.
 * Providers differ in patch/tile accounting: https://developers.openai.com/api/docs/guides/images-vision
 */
export function estimateContextTokens(value: unknown): number {
  let visionTokens = 0;
  const text = typeof value === 'string' ? value : serializeTextContext(value, detail => {
    visionTokens += detail === 'original' ? 32_768 : 4_096;
  });
  if (!text) return visionTokens;
  let ascii = 0;
  // Avoid allocating a match array with one entry per character of a large tool result.
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) <= 127) ascii++;
  return visionTokens + Math.ceil(ascii / 4 + (text.length - ascii) / 1.5);
}
