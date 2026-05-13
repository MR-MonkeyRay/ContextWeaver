import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProjectIdentity } from '../../src/db/index.js';
import type { ContextPack } from '../../src/search/types.js';

const { serviceBuildContextPackMock, serviceCloseMock, serviceInitMock, spawnMock } = vi.hoisted(
  () => ({
    spawnMock: vi.fn(),
    serviceInitMock: vi.fn(),
    serviceBuildContextPackMock: vi.fn(),
    serviceCloseMock: vi.fn(),
  }),
);

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('../../src/config.js', () => ({
  checkEmbeddingEnv: () => ({ missingVars: [] }),
  checkRerankerEnv: () => ({ missingVars: [] }),
  getEmbeddingConfig: () => ({ dimensions: 2 }),
  isDev: false,
  isMcpMode: false,
}));

vi.mock('../../src/search/SearchService.js', () => ({
  SearchService: vi.fn(function SearchService() {
    return {
      init: serviceInitMock,
      buildContextPack: serviceBuildContextPackMock,
      close: serviceCloseMock,
    };
  }),
}));

const tempDirs: string[] = [];
let previousHome: string | undefined;
let previousArgv1: string | undefined;
let previousContextWeaverCliEntry: string | undefined;
let previousCwCliEntry: string | undefined;

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createIndexedRepo(): Promise<{ repoPath: string; projectId: string }> {
  const repoPath = await createTempDir('cw-retrieval-repo-');
  const projectId = getProjectIdentity(repoPath).projectId;
  const projectDir = path.join(os.homedir(), '.contextweaver', projectId);
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, 'index.db'), '', 'utf-8');
  return { repoPath, projectId };
}

async function existingBundledCliEntryPaths(): Promise<string[]> {
  const candidates = ['dist/index.js', 'src/index.js', 'src/index.ts'].map((candidate) =>
    path.resolve(candidate),
  );
  const existingPaths: string[] = [];

  for (const candidate of candidates) {
    try {
      const stats = await fs.stat(candidate);
      if (stats.isFile()) {
        existingPaths.push(candidate);
      }
    } catch {
      // 继续尝试下一个候选入口
    }
  }

  return existingPaths;
}

beforeEach(async () => {
  previousHome = process.env.HOME;
  previousArgv1 = process.argv[1];
  previousContextWeaverCliEntry = process.env.CONTEXTWEAVER_CLI_ENTRY;
  previousCwCliEntry = process.env.CW_CLI_ENTRY;
  process.env.HOME = await createTempDir('cw-retrieval-home-');
  delete process.env.CONTEXTWEAVER_CLI_ENTRY;
  delete process.env.CW_CLI_ENTRY;
  vi.resetModules();
  spawnMock.mockReturnValue({ pid: 1234, unref: vi.fn() });
  serviceInitMock.mockResolvedValue(undefined);
  serviceBuildContextPackMock.mockResolvedValue(createPack());
  serviceCloseMock.mockReturnValue(undefined);
});

afterEach(async () => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }

  if (previousArgv1 === undefined) {
    process.argv.splice(1, 1);
  } else {
    process.argv[1] = previousArgv1;
  }

  if (previousContextWeaverCliEntry === undefined) {
    delete process.env.CONTEXTWEAVER_CLI_ENTRY;
  } else {
    process.env.CONTEXTWEAVER_CLI_ENTRY = previousContextWeaverCliEntry;
  }

  if (previousCwCliEntry === undefined) {
    delete process.env.CW_CLI_ENTRY;
  } else {
    process.env.CW_CLI_ENTRY = previousCwCliEntry;
  }

  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  vi.clearAllMocks();
});

function createPack(): ContextPack {
  return {
    query: 'trace prompt context flow',
    seeds: [
      {
        filePath: 'src/promptContext/index.ts',
        chunkIndex: 0,
        score: 0.91,
        source: 'vector',
        record: {
          chunk_id: 'chunk-0',
          file_path: 'src/promptContext/index.ts',
          file_hash: 'hash',
          chunk_index: 0,
          vector: [0.1, 0.2],
          display_code: 'export async function buildPromptContext() {}',
          vector_text: 'buildPromptContext',
          language: 'typescript',
          breadcrumb: 'fn buildPromptContext',
          start_index: 0,
          end_index: 10,
          raw_start: 0,
          raw_end: 10,
          vec_start: 0,
          vec_end: 10,
          _distance: 0.01,
        },
      },
    ],
    expanded: [],
    files: [
      {
        filePath: 'src/promptContext/index.ts',
        segments: [
          {
            filePath: 'src/promptContext/index.ts',
            rawStart: 0,
            rawEnd: 10,
            startLine: 1,
            endLine: 10,
            score: 0.91,
            breadcrumb: 'src/promptContext/index.ts > fn buildPromptContext',
            text: 'export async function buildPromptContext() {}',
          },
        ],
      },
    ],
    debug: {
      wVec: 0.7,
      wLex: 0.3,
      timingMs: { total: 12 },
    },
  };
}

describe('buildSearchResult', () => {
  it('builds a structured result from ContextPack', async () => {
    const { buildSearchResult } = await import('../../src/retrieval/index.js');
    const result = buildSearchResult(createPack());

    expect(result.summary).toEqual({
      query: 'trace prompt context flow',
      seedCount: 1,
      expandedCount: 0,
      fileCount: 1,
      totalSegments: 1,
    });
    expect(result.files[0]?.path).toBe('src/promptContext/index.ts');
    expect(result.files[0]?.segments[0]).toMatchObject({
      startLine: 1,
      endLine: 10,
      language: 'typescript',
      breadcrumb: 'src/promptContext/index.ts > fn buildPromptContext',
    });
  });
});

describe('renderSearchResult', () => {
  it('renders text output compatible with human reading', async () => {
    const { buildSearchResult, renderSearchResult } = await import('../../src/retrieval/index.js');
    const text = renderSearchResult(buildSearchResult(createPack()), 'text');

    expect(text).toContain('Found 1 relevant code blocks');
    expect(text).toContain('## src/promptContext/index.ts (L1-10)');
    expect(text).toContain('```typescript');
  });

  it('renders JSON output for scripts and skills', async () => {
    const { buildSearchResult, renderSearchResult } = await import('../../src/retrieval/index.js');
    const json = renderSearchResult(buildSearchResult(createPack()), 'json');
    const parsed = JSON.parse(json) as {
      summary: { fileCount: number };
      files: Array<{ path: string }>;
    };

    expect(parsed.summary.fileCount).toBe(1);
    expect(parsed.files[0]?.path).toBe('src/promptContext/index.ts');
  });
});

describe('retrieveCodeContext', () => {
  it('queries an existing index immediately and schedules background indexing once', async () => {
    const { retrieveCodeContext } = await import('../../src/retrieval/index.js');
    const { repoPath, projectId } = await createIndexedRepo();

    const result = await retrieveCodeContext({
      repoPath,
      informationRequest: 'trace prompt context flow',
    });

    expect(result.summary.seedCount).toBe(1);
    expect(serviceInitMock).toHaveBeenCalledTimes(1);
    expect(serviceBuildContextPackMock).toHaveBeenCalledTimes(1);
    expect(serviceCloseMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[0]).toBe(process.execPath);
    await expect(existingBundledCliEntryPaths()).resolves.toContain(
      spawnMock.mock.calls[0]?.[1]?.[0],
    );
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(['index', repoPath, '--yes']),
    );

    const markerPath = path.join(
      os.homedir(),
      '.contextweaver',
      projectId,
      'background-index.request',
    );
    await expect(fs.readFile(markerPath, 'utf-8')).resolves.toContain(String(process.pid));

    await retrieveCodeContext({
      repoPath,
      informationRequest: 'trace prompt context flow again',
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(serviceCloseMock).toHaveBeenCalledTimes(2);
  });

  it('closes SearchService when retrieval fails', async () => {
    const { retrieveCodeContext } = await import('../../src/retrieval/index.js');
    const { repoPath } = await createIndexedRepo();
    serviceBuildContextPackMock.mockRejectedValueOnce(new Error('search failed'));

    await expect(
      retrieveCodeContext({
        repoPath,
        informationRequest: 'trace prompt context flow',
      }),
    ).rejects.toThrow('search failed');

    expect(serviceCloseMock).toHaveBeenCalledTimes(1);
  });

  it('does not spawn an unrelated host script when used as a library', async () => {
    const hostScriptPath = path.join(await createTempDir('cw-host-'), 'host.js');
    await fs.writeFile(hostScriptPath, 'console.log("host")\n', 'utf-8');
    process.argv[1] = hostScriptPath;

    const { retrieveCodeContext } = await import('../../src/retrieval/index.js');
    const { repoPath } = await createIndexedRepo();

    await retrieveCodeContext({
      repoPath,
      informationRequest: 'trace prompt context flow',
    });

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    await expect(existingBundledCliEntryPaths()).resolves.toContain(
      spawnMock.mock.calls[0]?.[1]?.[0],
    );
    expect(spawnMock.mock.calls[0]?.[1]?.[0]).not.toBe(hostScriptPath);
  });

  it('uses an explicit CLI entry override when configured', async () => {
    const overrideEntryPath = path.join(await createTempDir('cw-cli-entry-'), 'contextweaver.js');
    await fs.writeFile(overrideEntryPath, 'console.log("contextweaver")\n', 'utf-8');
    process.env.CONTEXTWEAVER_CLI_ENTRY = overrideEntryPath;

    const { retrieveCodeContext } = await import('../../src/retrieval/index.js');
    const { repoPath } = await createIndexedRepo();

    await retrieveCodeContext({
      repoPath,
      informationRequest: 'trace prompt context flow',
    });

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    expect(spawnMock.mock.calls[0]?.[1]?.[0]).toBe(path.resolve(overrideEntryPath));
  });
});
