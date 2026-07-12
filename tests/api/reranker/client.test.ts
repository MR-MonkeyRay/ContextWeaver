import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RerankerClient } from '../../../src/api/reranker/index.js';

describe('RerankerClient entrypoint', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('keeps stable reranker entrypoint exports usable after provider refactor', async () => {
    global.fetch = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'test',
        results: [{ index: 1, relevance_score: 0.9 }],
      }),
    } as Response);

    const client = new RerankerClient({
      apiKey: 'test-key',
      baseUrl: 'https://example.com/rerank',
      model: 'test-reranker',
      topN: 5,
    });

    await expect(client.rerank('query', ['a', 'b'])).resolves.toEqual([
      {
        originalIndex: 1,
        score: 0.9,
        text: 'b',
      },
    ]);
  });

  it('aborts an in-flight rerank request when the caller cancels', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    global.fetch = fetchMock;
    const client = new RerankerClient({
      apiKey: 'test-key',
      baseUrl: 'https://example.com/rerank',
      model: 'test-reranker',
      topN: 5,
    });
    const request = client.rerank('query', ['a'], { signal: controller.signal });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort(new Error('client cancelled'));

    await expect(request).rejects.toThrow('client cancelled');
  });
});
