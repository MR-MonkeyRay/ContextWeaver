import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import {
  IndexAuthorizationRequiredError,
  type IndexConfirmationContext,
  IndexConfirmationDeclinedError,
} from '../../src/cli.js';
import {
  authorizeOrReturnRequired,
  buildAuthorizationPrompt,
  buildCliFallbackCommand,
  createMonotonicProgressForwarder,
  type McpToolRequestContext,
} from '../../src/mcp/authorization.js';

const confirmationContext: IndexConfirmationContext = {
  rootPath: "/tmp/repo with 'quote",
  identity: {
    projectId: '0123456789',
    projectPath: '/tmp/repo',
    pathBirthtimeMs: 1,
  },
  preview: {
    matchedFilePaths: ['/tmp/repo/src/index.ts'],
    totalFiles: 1,
    directorySummaries: ['src/: .ts(1)'],
    extensionSummaries: ['.ts(1)'],
    samplePaths: ['src/index.ts'],
  },
  scopeLines: ['索引范围:', '  - include: src/**'],
  projectConfigCreated: false,
};

function createRequestContext(
  response?: ElicitResult,
  overrides: Partial<McpToolRequestContext> = {},
): McpToolRequestContext {
  return {
    signal: new AbortController().signal,
    rootsAdvertised: false,
    supportsFormElicitation: true,
    elicit: vi.fn().mockResolvedValue(response ?? { action: 'accept', content: { approve: true } }),
    ...overrides,
  };
}

function createDependencies() {
  const ensureSearchableProject = vi.fn().mockRejectedValue(new IndexAuthorizationRequiredError());
  const runIndexCommand = vi.fn().mockImplementation(async (options) => {
    const confirmed = await options.confirmIndex(confirmationContext);
    if (!confirmed) {
      throw new IndexConfirmationDeclinedError();
    }
    options.onProgress?.(10, 100, '开始');
    return {
      totalFiles: 1,
      added: 1,
      modified: 0,
      unchanged: 0,
      deleted: 0,
      skipped: 0,
      errors: 0,
      skippedByReason: {},
    };
  });
  return { ensureSearchableProject, runIndexCommand };
}

describe('MCP first-index authorization', () => {
  it('skips Elicitation for an already confirmed repository', async () => {
    const context = createRequestContext();
    const ensureSearchableProject = vi.fn().mockResolvedValue(undefined);
    const runIndexCommand = vi.fn();

    await expect(
      authorizeOrReturnRequired('/tmp/repo', context, vi.fn(), {
        ensureSearchableProject,
        runIndexCommand: runIndexCommand as never,
      }),
    ).resolves.toEqual({ status: 'ready' });
    expect(context.elicit).not.toHaveBeenCalled();
    expect(runIndexCommand).not.toHaveBeenCalled();
  });

  it('returns portable CLI argv plus a POSIX display command without previewing', async () => {
    const dependencies = createDependencies();
    const context = createRequestContext(undefined, {
      supportsFormElicitation: false,
      elicit: undefined,
    });

    const result = await authorizeOrReturnRequired(
      confirmationContext.rootPath,
      context,
      vi.fn(),
      dependencies as never,
    );

    expect(result).toMatchObject({
      status: 'authorization_required',
      authorization: {
        reason: 'elicitation_unsupported',
        cliExecutable: 'cw',
        cliArgs: ['index', confirmationContext.rootPath],
        cliCommandShell: 'posix',
      },
    });
    expect(result.status === 'ready' ? '' : result.authorization.cliCommand).toBe(
      "cw index '/tmp/repo with '\\''quote'",
    );
    expect(dependencies.runIndexCommand).not.toHaveBeenCalled();
  });

  it('indexes only after accept plus approve true and forwards the exact callback context', async () => {
    const dependencies = createDependencies();
    const context = createRequestContext();
    const progress = vi.fn();

    await expect(
      authorizeOrReturnRequired('/tmp/repo', context, progress, dependencies as never),
    ).resolves.toEqual({ status: 'ready', indexedNow: true });

    expect(context.elicit).toHaveBeenCalledTimes(1);
    const request = vi.mocked(context.elicit as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(request?.message).toContain('实际匹配: 1 个文件');
    expect(request?.message).toContain('src/index.ts');
    expect(dependencies.runIndexCommand.mock.calls[0]?.[0]).not.toHaveProperty('yes');
    expect(progress).toHaveBeenCalledWith(10, 100, '开始');
  });

  it('coalesces concurrent first-index calls into one Elicitation and one indexing operation', async () => {
    const dependencies = createDependencies();
    let resolveElicitation: ((value: ElicitResult) => void) | undefined;
    const firstContext = createRequestContext(undefined, {
      elicit: vi.fn(
        () =>
          new Promise<ElicitResult>((resolve) => {
            resolveElicitation = resolve;
          }),
      ),
    });
    const secondContext = createRequestContext();

    const first = authorizeOrReturnRequired(
      '/tmp/concurrent-repo',
      firstContext,
      vi.fn(),
      dependencies as never,
    );
    await vi.waitFor(() => expect(firstContext.elicit).toHaveBeenCalledTimes(1));
    const second = authorizeOrReturnRequired(
      '/tmp/concurrent-repo',
      secondContext,
      vi.fn(),
      dependencies as never,
    );

    resolveElicitation?.({ action: 'accept', content: { approve: true } });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: 'ready', indexedNow: true },
      { status: 'ready', indexedNow: true },
    ]);
    expect(firstContext.elicit).toHaveBeenCalledTimes(1);
    expect(secondContext.elicit).not.toHaveBeenCalled();
    expect(dependencies.runIndexCommand).toHaveBeenCalledTimes(1);
  });

  it('lets a valid waiter retry when the single-flight owner is cancelled', async () => {
    const dependencies = createDependencies();
    const ownerController = new AbortController();
    const ownerContext = createRequestContext(undefined, {
      signal: ownerController.signal,
      elicit: vi.fn(
        (_params, options) =>
          new Promise<ElicitResult>((_resolve, reject) => {
            const signal = options?.signal;
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      ),
    });
    const waiterContext = createRequestContext();

    const owner = authorizeOrReturnRequired(
      '/tmp/cancelled-owner-repo',
      ownerContext,
      vi.fn(),
      dependencies as never,
    );
    await vi.waitFor(() => expect(ownerContext.elicit).toHaveBeenCalledTimes(1));
    const waiter = authorizeOrReturnRequired(
      '/tmp/cancelled-owner-repo',
      waiterContext,
      vi.fn(),
      dependencies as never,
    );

    ownerController.abort('client cancelled');

    await expect(owner).rejects.toBe('client cancelled');
    await expect(waiter).resolves.toEqual({ status: 'ready', indexedNow: true });
    expect(ownerContext.elicit).toHaveBeenCalledTimes(1);
    expect(waiterContext.elicit).toHaveBeenCalledTimes(1);
    expect(dependencies.runIndexCommand).toHaveBeenCalledTimes(2);
  });

  it('honors cancellation after an accepted Elicitation before scan starts', async () => {
    const controller = new AbortController();
    const scanStarted = vi.fn();
    const ensureSearchableProject = vi
      .fn()
      .mockRejectedValue(new IndexAuthorizationRequiredError());
    const runIndexCommand = vi.fn().mockImplementation(async (options) => {
      const confirmed = await options.confirmIndex(confirmationContext);
      if (confirmed) {
        scanStarted();
      }
    });
    const context = createRequestContext(undefined, {
      signal: controller.signal,
      elicit: vi.fn().mockImplementation(async () => {
        controller.abort();
        return { action: 'accept', content: { approve: true } };
      }),
    });

    await expect(
      authorizeOrReturnRequired('/tmp/cancelled-repo', context, vi.fn(), {
        ensureSearchableProject,
        runIndexCommand: runIndexCommand as never,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(scanStarted).not.toHaveBeenCalled();
  });

  it.each([
    ['decline', { action: 'decline' }, 'elicitation_declined'],
    ['cancel', { action: 'cancel' }, 'elicitation_cancelled'],
    ['approve false', { action: 'accept', content: { approve: false } }, 'approval_false'],
    ['malformed', { action: 'accept', content: {} }, 'invalid_elicitation_response'],
  ])('does not authorize on %s', async (_label, response, reason) => {
    const dependencies = createDependencies();
    const result = await authorizeOrReturnRequired(
      '/tmp/repo',
      createRequestContext(response as ElicitResult),
      vi.fn(),
      dependencies as never,
    );

    expect(result).toMatchObject({ status: 'declined', authorization: { reason } });
  });

  it('sanitizes configured keys, URL credentials, and query strings at the prompt boundary', () => {
    const previousEmbeddingKey = process.env.EMBEDDINGS_API_KEY;
    const previousRerankKey = process.env.RERANK_API_KEY;
    process.env.EMBEDDINGS_API_KEY = 'embedding-secret';
    process.env.RERANK_API_KEY = 'rerank-secret';

    try {
      const message = buildAuthorizationPrompt(confirmationContext, {
        embedding: {
          origin: 'https://user:pass@embedding.example.com/v1?token=origin-secret',
          model: 'embed-model embedding-secret https://model-user:model-pass@example.com/m?token=x',
        },
        reranker: {
          origin: 'https://rerank.example.com/v1?api_key=origin-secret',
          model: 'rerank-model rerank-secret',
        },
      });

      expect(message).toContain('https://embedding.example.com');
      expect(message).toContain('embed-model <redacted>');
      expect(message).not.toContain('embedding-secret');
      expect(message).not.toContain('rerank-secret');
      expect(message).not.toContain('user:pass');
      expect(message).not.toContain('model-user:model-pass');
      expect(message).not.toContain('origin-secret');
      expect(message).not.toContain('token=x');
      expect(buildCliFallbackCommand("/tmp/a'b")).toBe("cw index '/tmp/a'\\''b'");
    } finally {
      if (previousEmbeddingKey === undefined) {
        delete process.env.EMBEDDINGS_API_KEY;
      } else {
        process.env.EMBEDDINGS_API_KEY = previousEmbeddingKey;
      }
      if (previousRerankKey === undefined) {
        delete process.env.RERANK_API_KEY;
      } else {
        process.env.RERANK_API_KEY = previousRerankKey;
      }
    }
  });
});

describe('MCP progress forwarding', () => {
  it('requires a token, suppresses duplicate/regressing progress, and ignores notification failure', async () => {
    const sendProgress = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('transport closed'));
    const progress = createMonotonicProgressForwarder({ progressToken: 'request-1', sendProgress });

    progress.report(10, 100, 'start');
    progress.report(10, 100, 'duplicate');
    progress.report(9, 100, 'regression');
    progress.report(20, 100, 'continue');
    await progress.complete();
    progress.report(30, 100, 'late');

    expect(sendProgress).toHaveBeenCalledTimes(2);
    expect(sendProgress.mock.calls.map(([update]) => update.progress)).toEqual([10, 20]);

    const withoutToken = vi.fn();
    createMonotonicProgressForwarder({ sendProgress: withoutToken }).report(1, 1, 'ignored');
    expect(withoutToken).not.toHaveBeenCalled();
  });
});
