import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REQUIRED_EMBEDDING_ENV = {
  EMBEDDINGS_API_KEY: 'test-key',
  EMBEDDINGS_BASE_URL: 'https://example.com/embeddings',
  EMBEDDINGS_MODEL: 'test-model',
};

describe('getEmbeddingConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, ...REQUIRED_EMBEDDING_ENV };
    delete process.env.EMBEDDINGS_BATCH_SIZE;
    delete process.env.EMBEDDINGS_NETWORK_RETRIES;
    delete process.env.EMBEDDINGS_RETRY_BASE_DELAY_MS;
    delete process.env.EMBEDDINGS_RETRY_INTERVAL_INCREMENT_MS;
    delete process.env.EMBEDDINGS_REQUEST_TIMEOUT_MS;
    delete process.env.EMBEDDINGS_WINDOW_SIZE;
    delete process.env.CW_CHUNK_MAX_SIZE;
    delete process.env.CW_CHUNK_MIN_SIZE;
    delete process.env.CW_CHUNK_OVERLAP;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses 10 as the default batchSize', async () => {
    const { getEmbeddingConfig } = await import('../src/config.js');

    expect(getEmbeddingConfig().batchSize).toBe(10);
  });

  it('uses a valid EMBEDDINGS_BATCH_SIZE value', async () => {
    process.env.EMBEDDINGS_BATCH_SIZE = '16';
    const { getEmbeddingConfig } = await import('../src/config.js');

    expect(getEmbeddingConfig().batchSize).toBe(16);
  });

  it('falls back to 10 for invalid EMBEDDINGS_BATCH_SIZE values', async () => {
    process.env.EMBEDDINGS_BATCH_SIZE = 'oops';
    const { getEmbeddingConfig } = await import('../src/config.js');

    expect(getEmbeddingConfig().batchSize).toBe(10);
  });

  it('falls back to 10 when EMBEDDINGS_BATCH_SIZE is smaller than 1', async () => {
    process.env.EMBEDDINGS_BATCH_SIZE = '0';
    const { getEmbeddingConfig } = await import('../src/config.js');

    expect(getEmbeddingConfig().batchSize).toBe(10);
  });

  it('uses default retry and window tuning values', async () => {
    const { getEmbeddingConfig } = await import('../src/config.js');

    expect(getEmbeddingConfig()).toMatchObject({
      networkRetries: 5,
      retryBaseDelayMs: 1000,
      retryIntervalIncrementMs: 1000,
      requestTimeoutMs: 60000,
      windowSize: 50,
      chunkMaxSize: 1000,
      chunkMinSize: 50,
      chunkOverlap: 20,
    });
  });

  it('allows disabling increasing retry interval with zero', async () => {
    process.env.EMBEDDINGS_RETRY_INTERVAL_INCREMENT_MS = '0';
    const { getEmbeddingConfig } = await import('../src/config.js');

    expect(getEmbeddingConfig().retryIntervalIncrementMs).toBe(0);
  });

  it('uses configured retry and index tuning values', async () => {
    process.env.EMBEDDINGS_NETWORK_RETRIES = '7';
    process.env.EMBEDDINGS_RETRY_BASE_DELAY_MS = '250';
    process.env.EMBEDDINGS_RETRY_INTERVAL_INCREMENT_MS = '125';
    process.env.EMBEDDINGS_REQUEST_TIMEOUT_MS = '30000';
    process.env.EMBEDDINGS_WINDOW_SIZE = '12';
    process.env.CW_CHUNK_MAX_SIZE = '1500';
    process.env.CW_CHUNK_MIN_SIZE = '80';
    process.env.CW_CHUNK_OVERLAP = '10';
    const { getEmbeddingConfig } = await import('../src/config.js');

    expect(getEmbeddingConfig()).toMatchObject({
      networkRetries: 7,
      retryBaseDelayMs: 250,
      retryIntervalIncrementMs: 125,
      requestTimeoutMs: 30000,
      windowSize: 12,
      chunkMaxSize: 1500,
      chunkMinSize: 80,
      chunkOverlap: 10,
    });
  });
});
