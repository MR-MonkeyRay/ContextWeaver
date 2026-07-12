import { describe, expect, it, vi } from 'vitest';
import type { McpToolRequestContext } from '../../src/mcp/authorization.js';
import {
  codebaseRetrievalOutputSchema,
  createCodebaseRetrievalHandler,
} from '../../src/mcp/tools/codebaseRetrieval.js';
import {
  createPromptContextHandler,
  promptContextOutputSchema,
} from '../../src/mcp/tools/promptContext.js';
import type { SearchResult } from '../../src/retrieval/index.js';

const searchResult: SearchResult = {
  summary: {
    query: 'SearchService flow',
    seedCount: 1,
    expandedCount: 0,
    fileCount: 1,
    totalSegments: 1,
  },
  files: [
    {
      path: 'src/search/SearchService.ts',
      segments: [
        {
          startLine: 1,
          endLine: 3,
          score: 0.9,
          language: 'typescript',
          breadcrumb: 'class SearchService',
          text: 'export class SearchService {}',
        },
      ],
    },
  ],
};

function requestContext(): McpToolRequestContext {
  return {
    signal: new AbortController().signal,
    rootsAdvertised: false,
    supportsFormElicitation: false,
  };
}

describe('MCP tool adapters', () => {
  it('maps codebase-retrieval snake_case input and returns dual output', async () => {
    const context = requestContext();
    const retrieveCodeContext = vi.fn().mockResolvedValue(searchResult);
    const handler = createCodebaseRetrievalHandler({
      resolveRepositoryPath: vi.fn().mockResolvedValue('/canonical/repo') as never,
      authorize: vi.fn().mockResolvedValue({ status: 'ready', indexedNow: true }) as never,
      retrieveCodeContext,
    });

    const response = await handler(
      {
        repo_path: '/repo',
        information_request: 'SearchService flow',
        technical_terms: ['SearchService'],
      },
      context,
    );

    expect(retrieveCodeContext).toHaveBeenCalledWith(
      {
        repoPath: '/canonical/repo',
        informationRequest: 'SearchService flow',
        technicalTerms: ['SearchService'],
      },
      expect.objectContaining({
        onProgress: expect.any(Function),
        signal: context.signal,
        skipBackgroundIndex: true,
      }),
    );
    expect(response.structuredContent).toMatchObject({ status: 'ok', result: searchResult });
    expect(
      JSON.parse(response.content[0]?.type === 'text' ? response.content[0].text : '{}'),
    ).toEqual(response.structuredContent);
  });

  it('returns authorization business state without retrieval', async () => {
    const retrieveCodeContext = vi.fn();
    const handler = createCodebaseRetrievalHandler({
      resolveRepositoryPath: vi.fn().mockResolvedValue('/repo') as never,
      authorize: vi.fn().mockResolvedValue({
        status: 'authorization_required',
        authorization: {
          repoPath: '/repo',
          reason: 'elicitation_unsupported',
          message: '需要授权',
          cliExecutable: 'cw',
          cliArgs: ['index', '/repo'],
          cliCommand: "cw index '/repo'",
          cliCommandShell: 'posix',
        },
      }) as never,
      retrieveCodeContext,
    });

    const response = await handler(
      { repo_path: '/repo', information_request: 'flow' },
      requestContext(),
    );

    expect(response.isError).toBeUndefined();
    expect(response.structuredContent).toMatchObject({ status: 'authorization_required' });
    expect(codebaseRetrievalOutputSchema.safeParse(response.structuredContent).success).toBe(true);
    expect(retrieveCodeContext).not.toHaveBeenCalled();
  });

  it.each([
    'authorization_required',
    'declined',
  ] as const)('returns prompt-context %s without building context', async (status) => {
    const buildPromptContext = vi.fn();
    const authorization = {
      repoPath: '/repo',
      reason:
        status === 'authorization_required'
          ? ('elicitation_unsupported' as const)
          : ('elicitation_declined' as const),
      message: '需要授权',
      cliExecutable: 'cw',
      cliArgs: ['index', '/repo'],
      cliCommand: "cw index '/repo'",
      cliCommandShell: 'posix' as const,
    };
    const handler = createPromptContextHandler({
      resolveRepositoryPath: vi.fn().mockResolvedValue('/repo') as never,
      authorize: vi.fn().mockResolvedValue({ status, authorization }) as never,
      buildPromptContext,
    });

    const response = await handler(
      { prompt: 'Refactor SearchService', repo_path: '/repo' },
      requestContext(),
    );

    expect(response.structuredContent).toMatchObject({ status, authorization });
    expect(promptContextOutputSchema.safeParse(response.structuredContent).success).toBe(true);
    expect(buildPromptContext).not.toHaveBeenCalled();
  });

  it('keeps prompt-only context local and maps optional arrays', async () => {
    const resolveRepositoryPath = vi.fn();
    const authorize = vi.fn();
    const buildPromptContext = vi.fn().mockResolvedValue({
      prompt: 'Refactor SearchService',
      language: 'en',
      technicalTerms: ['SearchService'],
      retrieval: { status: 'skipped', topPaths: [], evidence: [] },
    });
    const handler = createPromptContextHandler({
      resolveRepositoryPath: resolveRepositoryPath as never,
      authorize: authorize as never,
      buildPromptContext,
    });

    const response = await handler(
      {
        prompt: 'Refactor SearchService',
        paths: ['src/search/SearchService.ts'],
        symbols: ['SearchService'],
      },
      requestContext(),
    );

    expect(resolveRepositoryPath).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(buildPromptContext).toHaveBeenCalledWith({
      prompt: 'Refactor SearchService',
      repoPath: undefined,
      explicitPaths: ['src/search/SearchService.ts'],
      explicitSymbols: ['SearchService'],
    });
    expect(response.structuredContent).toMatchObject({ status: 'ok' });
    expect(promptContextOutputSchema.safeParse(response.structuredContent).success).toBe(true);
  });

  it('sanitizes runtime errors and marks them as tool errors', async () => {
    const handler = createCodebaseRetrievalHandler({
      resolveRepositoryPath: vi.fn().mockResolvedValue('/repo') as never,
      authorize: vi.fn().mockResolvedValue({ status: 'ready' }) as never,
      retrieveCodeContext: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'failed https://user:pass@example.com/api?token=secret\nAuthorization: Bearer bearer-secret\nProxy-Authorization: Basic basic-secret\nCookie: session=cookie-secret',
          ),
        ),
    });

    const response = await handler(
      { repo_path: '/repo', information_request: 'flow' },
      requestContext(),
    );

    expect(response.isError).toBe(true);
    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    expect(text).toContain('https://example.com');
    expect(text).not.toContain('user:pass');
    expect(text).not.toContain('token=secret');
    expect(text).not.toContain('bearer-secret');
    expect(text).not.toContain('basic-secret');
    expect(text).not.toContain('cookie-secret');
  });
});
