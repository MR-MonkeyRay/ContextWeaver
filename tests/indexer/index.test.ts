import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingFatalError } from '../../src/api/embedding/index.js';
import { Indexer } from '../../src/indexer/index.js';
import type { ProcessResult } from '../../src/scanner/processor.js';

function createProcessResult(): ProcessResult {
  return {
    absPath: '/repo/src/app.ts',
    relPath: 'src/app.ts',
    hash: 'hash-1',
    content: 'export const app = true;',
    language: 'typescript',
    mtime: 1,
    size: 1,
    status: 'added',
    chunks: [
      {
        displayCode: 'export const app = true;',
        vectorText: 'export const app = true;',
        nwsSize: 1,
        metadata: {
          startIndex: 0,
          endIndex: 24,
          rawSpan: { start: 0, end: 24 },
          vectorSpan: { start: 0, end: 24 },
          filePath: 'src/app.ts',
          language: 'typescript',
          contextPath: ['src/app.ts'],
        },
      },
    ],
  };
}

function createProcessResultForPath(relPath: string, hash: string): ProcessResult {
  return {
    ...createProcessResult(),
    absPath: `/repo/${relPath}`,
    relPath,
    hash,
    content: `export const value = '${relPath}';`,
    chunks: [
      {
        ...createProcessResult().chunks[0],
        displayCode: `export const value = '${relPath}';`,
        vectorText: `export const value = '${relPath}';`,
        metadata: {
          ...createProcessResult().chunks[0].metadata,
          filePath: relPath,
          contextPath: [relPath],
        },
      },
    ],
  };
}

describe('Indexer fatal embedding propagation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clears vector_index_hash and rethrows embedding fatal failures instead of returning error stats', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        vector_index_hash TEXT
      );
      INSERT INTO files (path, hash, vector_index_hash)
      VALUES ('src/app.ts', 'hash-1', 'hash-1');
    `);

    const indexer = new Indexer('project-id');
    (indexer as any).vectorStore = {};
    const upstreamError = new EmbeddingFatalError('Embedding API 错误: quota exceeded', {
      diagnostics: {
        stage: 'embed',
        category: 'rate_limit',
        httpStatus: 429,
        providerType: 'rate_limit_error',
        providerCode: 'quota_exceeded',
        upstreamMessage: 'quota exceeded',
        endpointHost: 'api.example.com',
        endpointPath: '/v1/embeddings',
        model: 'text-embedding-3-large',
        batchSize: 20,
        dimensions: 1024,
        requestCount: 1,
      },
    } as any);

    (indexer as any).embeddingClient = {
      getConfig: vi.fn().mockReturnValue({ batchSize: 20, windowSize: 50 }),
      embedBatch: vi.fn().mockRejectedValue(upstreamError),
    };

    const error = await indexer.indexFiles(db, [createProcessResult()]).catch((err) => err);

    expect(error).toBeInstanceOf(EmbeddingFatalError);
    expect(error.message).toContain('向量嵌入阶段失败: quota exceeded');
    expect(error.diagnostics).toMatchObject({
      stage: 'embed',
      category: 'rate_limit',
      httpStatus: 429,
      providerType: 'rate_limit_error',
      providerCode: 'quota_exceeded',
      upstreamMessage: 'quota exceeded',
      endpointHost: 'api.example.com',
      endpointPath: '/v1/embeddings',
      model: 'text-embedding-3-large',
      batchSize: 20,
      dimensions: 1024,
      requestCount: 1,
    });
    expect(error.diagnostics.stage).toBe('embed');

    const row = db
      .prepare('SELECT vector_index_hash FROM files WHERE path = ?')
      .get('src/app.ts') as { vector_index_hash: string | null };
    expect(row.vector_index_hash).toBeNull();

    db.close();
  });

  it('persists successful windows and leaves failed windows for self-healing', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        vector_index_hash TEXT
      );
      INSERT INTO files (path, hash, vector_index_hash)
      VALUES
        ('src/a.ts', 'hash-a', NULL),
        ('src/b.ts', 'hash-b', NULL);
    `);

    const indexer = new Indexer('project-id');
    const batchUpsertFiles = vi.fn().mockResolvedValue(undefined);
    (indexer as any).vectorStore = { batchUpsertFiles };
    const upstreamError = new EmbeddingFatalError('Embedding API 错误: fetch failed', {
      diagnostics: {
        stage: 'embed',
        category: 'network',
        httpStatus: null,
        providerType: null,
        providerCode: null,
        upstreamMessage: 'fetch failed',
        endpointHost: 'api.example.com',
        endpointPath: '/v1/embeddings',
        model: 'text-embedding-3-large',
        batchSize: 1,
        dimensions: 1024,
        requestCount: 1,
      },
    });
    (indexer as any).embeddingClient = {
      getConfig: vi.fn().mockReturnValue({ batchSize: 1, windowSize: 1 }),
      embedBatch: vi
        .fn()
        .mockResolvedValueOnce([{ embedding: [0.1, 0.2, 0.3] }])
        .mockRejectedValueOnce(upstreamError),
    };

    const error = await indexer
      .indexFiles(db, [
        createProcessResultForPath('src/a.ts', 'hash-a'),
        createProcessResultForPath('src/b.ts', 'hash-b'),
      ])
      .catch((err) => err);

    expect(error).toBeInstanceOf(EmbeddingFatalError);
    expect(batchUpsertFiles).toHaveBeenCalledTimes(1);
    const rows = db
      .prepare('SELECT path, vector_index_hash FROM files ORDER BY path')
      .all() as Array<{ path: string; vector_index_hash: string | null }>;
    expect(rows).toEqual([
      { path: 'src/a.ts', vector_index_hash: 'hash-a' },
      { path: 'src/b.ts', vector_index_hash: null },
    ]);

    db.close();
  });

  it('stops remaining windows after deterministic embedding failures', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        vector_index_hash TEXT
      );
      INSERT INTO files (path, hash, vector_index_hash)
      VALUES
        ('src/a.ts', 'hash-a', NULL),
        ('src/b.ts', 'hash-b', NULL);
    `);

    const indexer = new Indexer('project-id');
    (indexer as any).vectorStore = { batchUpsertFiles: vi.fn().mockResolvedValue(undefined) };
    const upstreamError = new EmbeddingFatalError('Embedding API 错误: invalid key', {
      diagnostics: {
        stage: 'embed',
        category: 'authentication',
        httpStatus: 401,
        providerType: 'invalid_request_error',
        providerCode: 'invalid_api_key',
        upstreamMessage: 'invalid key',
        endpointHost: 'api.example.com',
        endpointPath: '/v1/embeddings',
        model: 'text-embedding-3-large',
        batchSize: 1,
        dimensions: 1024,
        requestCount: 1,
      },
    });
    const embedBatch = vi.fn().mockRejectedValue(upstreamError);
    (indexer as any).embeddingClient = {
      getConfig: vi.fn().mockReturnValue({ batchSize: 1, windowSize: 1 }),
      embedBatch,
    };

    const error = await indexer
      .indexFiles(db, [
        createProcessResultForPath('src/a.ts', 'hash-a'),
        createProcessResultForPath('src/b.ts', 'hash-b'),
      ])
      .catch((err) => err);

    expect(error).toBeInstanceOf(EmbeddingFatalError);
    expect(embedBatch).toHaveBeenCalledTimes(1);

    db.close();
  });
});
