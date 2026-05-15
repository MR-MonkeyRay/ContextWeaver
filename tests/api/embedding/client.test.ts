import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingClient, resetEmbeddingClientForTests } from '../../../src/api/embedding/index.js';

type TestableEmbeddingClient = {
  processBatch: (
    texts: string[],
    startIndex: number,
    batchSize: number,
    progress: { recordBatch: ReturnType<typeof vi.fn> },
    session: { fatalError: null; controllers: Set<AbortController> },
  ) => Promise<unknown>;
};

function createClient(overrides?: Partial<ConstructorParameters<typeof EmbeddingClient>[0]>) {
  return new EmbeddingClient({
    apiKey: 'test-key',
    baseUrl: 'https://example.com/embeddings',
    model: 'test-model',
    batchSize: 2,
    maxConcurrency: 1,
    networkRetries: 3,
    retryBaseDelayMs: 0,
    retryIntervalIncrementMs: 0,
    requestTimeoutMs: 0,
    windowSize: 50,
    dimensions: 3,
    maxInputTokens: 1000,
    chunkMaxSize: 1000,
    chunkMinSize: 50,
    chunkOverlap: 20,
    ...overrides,
  });
}

function successResponse(index: number) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: [{ index, embedding: [index + 0.1, index + 0.2, index + 0.3] }],
      usage: { total_tokens: 10 },
    }),
  } as Response;
}

function failureResponse(message: string) {
  return {
    ok: false,
    status: 500,
    json: async () => ({ error: { message } }),
  } as Response;
}

function fatalFailureResponse(message: string) {
  return {
    ok: false,
    status: 400,
    json: async () => ({ error: { message: `Dimension mismatch: ${message}` } }),
  } as Response;
}

describe('EmbeddingClient orchestration', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    resetEmbeddingClientForTests();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    resetEmbeddingClientForTests();
  });

  it('stops starting unstarted batches after the first fatal embedding failure', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(successResponse(0))
      .mockResolvedValueOnce(fatalFailureResponse('provider exploded'));
    global.fetch = fetchMock;

    const client = createClient({ maxConcurrency: 1 });

    await expect(client.embedBatch(['a', 'b', 'c'], 1)).rejects.toThrow('Dimension mismatch');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('discards late successful results after fatal state without advancing progress', async () => {
    const onProgress = vi.fn();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            setTimeout(() => resolve(successResponse(0)), 20);
          }),
      )
      .mockResolvedValueOnce(fatalFailureResponse('fatal batch failure'));
    global.fetch = fetchMock;

    const client = createClient({ maxConcurrency: 2 });

    await expect(client.embedBatch(['a', 'b', 'c'], 1, onProgress)).rejects.toThrow(
      'Dimension mismatch',
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('rechecks request safety before sending even if unsafe text reaches the embedding layer', async () => {
    global.fetch = vi.fn<typeof fetch>();

    const client = createClient({ maxInputTokens: 10 });

    await expect(
      (client as unknown as TestableEmbeddingClient).processBatch(
        ['abcdefghij'],
        0,
        1,
        { recordBatch: vi.fn() },
        { fatalError: null, controllers: new Set() },
      ),
    ).rejects.toThrow('发送前预算校验失败');

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('keeps stable embedding entrypoint exports usable after provider refactor', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(successResponse(0));
    global.fetch = fetchMock;

    const client = new EmbeddingClient({
      apiKey: 'test-key',
      baseUrl: 'https://example.com/embeddings',
      model: 'test-model',
      batchSize: 2,
      maxConcurrency: 1,
      networkRetries: 3,
      retryBaseDelayMs: 0,
      retryIntervalIncrementMs: 0,
      requestTimeoutMs: 0,
      windowSize: 50,
      dimensions: 3,
      maxInputTokens: 1000,
      chunkMaxSize: 1000,
      chunkMinSize: 50,
      chunkOverlap: 20,
    });

    await expect(client.embed('hello')).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses config.batchSize when embedBatch is called without an explicit batchSize', async () => {
    const client = createClient({ batchSize: 2 });
    const processBatchSpy = vi
      .spyOn(client as any, 'processBatch')
      .mockImplementation(async (...args: any[]) => {
        const [texts, startIndex, _batchSize, progress] = args as [
          string[],
          number,
          number,
          { recordBatch: (tokens: number) => void },
        ];

        progress.recordBatch(1);
        return texts.map((_, index) => ({
          embedding: [startIndex + index + 0.1, 0.2, 0.3],
          tokens: 1,
        }));
      });

    const results = await client.embedBatch(['a', 'b', 'c']);

    expect(results).toHaveLength(3);
    expect(processBatchSpy).toHaveBeenCalledTimes(2);
    expect(processBatchSpy.mock.calls[0]?.[2]).toBe(2);
    expect(processBatchSpy.mock.calls[1]?.[2]).toBe(2);
  });

  it('uses configured increasing retry delay for transient network failures', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }))
      .mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce(successResponse(0));
    global.fetch = fetchMock;

    const client = createClient({
      networkRetries: 2,
      retryBaseDelayMs: 100,
      retryIntervalIncrementMs: 50,
    });
    const resultPromise = client.embedBatch(['a'], 1);

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(150);

    await expect(resultPromise).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('keeps retry delay fixed when interval increment is disabled', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }))
      .mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce(successResponse(0));
    global.fetch = fetchMock;

    const client = createClient({
      networkRetries: 2,
      retryBaseDelayMs: 100,
      retryIntervalIncrementMs: 0,
    });
    const resultPromise = client.embedBatch(['a'], 1);

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    await expect(resultPromise).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});
