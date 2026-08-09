import type { ImageGenerationResult } from './providers/types.js';
import { MAX_GENERATED_IMAGE_BYTES } from './media-artifact-store.js';

export { MAX_GENERATED_IMAGE_BYTES } from './media-artifact-store.js';

const INVALID_BASE64_CHARACTER = /[^A-Za-z0-9+/=]/;

const GENERATED_IMAGE_NAMES = {
  'image/gif': 'generated-image.gif',
  'image/jpeg': 'generated-image.jpg',
  'image/png': 'generated-image.png',
  'image/webp': 'generated-image.webp',
} as const;

type SupportedGeneratedImageMediaType = keyof typeof GENERATED_IMAGE_NAMES;

export interface DecodedGeneratedImageArtifact {
  bytes: Buffer;
  mediaType: SupportedGeneratedImageMediaType;
  originalName: string;
}

export interface GeneratedImageDecoderOptions {
  decodeBase64?: (value: string) => Buffer;
}

function canonicalMediaType(value: string): SupportedGeneratedImageMediaType {
  const mediaType = value.toLowerCase();
  if (!Object.hasOwn(GENERATED_IMAGE_NAMES, mediaType)) {
    throw new Error(`Generated image MIME is unsupported: ${value}`);
  }
  return mediaType as SupportedGeneratedImageMediaType;
}

function decodedBase64Bytes(value: string): number {
  if (value.length === 0 || value.length % 4 !== 0) {
    throw new Error('Generated image data must be canonical base64');
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const bytes = (value.length / 4) * 3 - padding;
  if (bytes > MAX_GENERATED_IMAGE_BYTES) {
    throw new Error(`Generated image exceeds ${MAX_GENERATED_IMAGE_BYTES} bytes`);
  }
  const firstPadding = value.indexOf('=');
  if (
    INVALID_BASE64_CHARACTER.test(value)
    || (firstPadding !== -1 && firstPadding !== value.length - padding)
  ) {
    throw new Error('Generated image data must be canonical base64');
  }
  return bytes;
}

export function decodeGeneratedImageArtifact(
  artifacts: ImageGenerationResult['artifacts'],
  options: GeneratedImageDecoderOptions = {},
): DecodedGeneratedImageArtifact {
  if (artifacts.length !== 1) {
    throw new Error('Image generation must return exactly one inline artifact');
  }
  const artifact = artifacts[0]!;
  if (artifact.url !== undefined || artifact.data === undefined) {
    throw new Error('Generated image artifacts must contain inline data only');
  }

  const mediaType = canonicalMediaType(artifact.mediaType);
  const expectedBytes = decodedBase64Bytes(artifact.data);

  const bytes = (options.decodeBase64 ?? ((value) => Buffer.from(value, 'base64')))(artifact.data);
  if (bytes.byteLength !== expectedBytes || bytes.toString('base64') !== artifact.data) {
    throw new Error('Generated image data must be canonical base64');
  }

  return {
    bytes,
    mediaType,
    originalName: GENERATED_IMAGE_NAMES[mediaType],
  };
}
