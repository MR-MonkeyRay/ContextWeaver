import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/search/config.js';
import { GraphExpander } from '../../src/search/GraphExpander.js';
import type { ScoredChunk } from '../../src/search/types.js';

const seed: ScoredChunk = {
  filePath: 'src/a.ts',
  chunkIndex: 0,
  score: 1,
  source: 'vector',
  record: {
    chunk_id: 'src/a.ts#0',
    file_path: 'src/a.ts',
    file_hash: 'hash',
    chunk_index: 0,
    vector: [0.1, 0.2],
    display_code: "import './b.js';",
    vector_text: "import './b.js';",
    language: 'typescript',
    breadcrumb: 'src/a.ts > function a',
    start_index: 0,
    end_index: 10,
    raw_start: 0,
    raw_end: 10,
    vec_start: 0,
    vec_end: 10,
    _distance: 0,
  },
};

describe('GraphExpander cancellation', () => {
  it('does not start later expansion phases after cancellation during E1', async () => {
    const controller = new AbortController();
    let resolveNeighbors: ((value: Map<string, never[]>) => void) | undefined;
    const getFilesChunks = vi.fn().mockImplementationOnce(
      () =>
        new Promise<Map<string, never[]>>((resolve) => {
          resolveNeighbors = resolve;
        }),
    );
    const getFileChunks = vi.fn();
    const expander = new GraphExpander('project-id', DEFAULT_CONFIG);
    Object.assign(expander as object, {
      vectorStore: { getFilesChunks, getFileChunks },
      db: {
        prepare: () => ({
          all: () => [{ path: 'src/a.ts' }],
          get: () => ({ content: "import './b.js';" }),
        }),
      },
    });

    const expansion = expander.expand([seed], undefined, controller.signal);
    await vi.waitFor(() => expect(getFilesChunks).toHaveBeenCalledTimes(1));
    controller.abort(new Error('client cancelled'));
    resolveNeighbors?.(new Map([['src/a.ts', []]]));

    await expect(expansion).rejects.toThrow('client cancelled');
    expect(getFilesChunks).toHaveBeenCalledTimes(1);
    expect(getFileChunks).not.toHaveBeenCalled();
  });
});
