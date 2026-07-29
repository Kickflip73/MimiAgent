import assert from 'node:assert/strict';
import test from 'node:test';
import { embeddingClientConfig } from '../src/runtime/components.js';

test('MemoryHub keeps OPENAI_API_KEY as the backward-compatible embedding default', () => {
  assert.deepEqual(embeddingClientConfig({
    OPENAI_API_KEY: 'openai-key',
  }), {
    apiKey: 'openai-key',
  });
});

test('MemoryHub accepts an independent OpenAI-compatible embedding endpoint', () => {
  assert.deepEqual(embeddingClientConfig({
    OPENAI_API_KEY: 'chat-key',
    MIMI_EMBEDDING_API_KEY: 'embedding-key',
    MIMI_EMBEDDING_BASE_URL: 'https://embedding.example/v1',
  }), {
    apiKey: 'embedding-key',
    baseURL: 'https://embedding.example/v1',
  });
});

test('MemoryHub does not assume a chat-only DeepSeek credential supports embeddings', () => {
  assert.equal(embeddingClientConfig({
    DEEPSEEK_API_KEY: 'deepseek-chat-key',
  }), undefined);
});
