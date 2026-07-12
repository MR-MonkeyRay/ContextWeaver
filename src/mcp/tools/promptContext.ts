import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  buildPromptContext as defaultBuildPromptContext,
  type PromptContextResult,
} from '../../promptContext/index.js';

import {
  type AuthorizationDependencies,
  authorizeOrReturnRequired,
  createMonotonicProgressForwarder,
  type McpToolRequestContext,
} from '../authorization.js';
import { resolveRepositoryPath } from '../pathPolicy.js';
import {
  authorizationMetadataSchema,
  sanitizeErrorMessage,
  toBusinessToolResult,
  toErrorToolResult,
} from '../result.js';

const promptContextResultSchema = z.object({
  prompt: z.string(),
  language: z.enum(['zh', 'en']),
  technicalTerms: z.array(z.string()),
  retrieval: z.object({
    status: z.enum(['ok', 'skipped', 'error']),
    error: z.string().optional(),
    topPaths: z.array(z.string()),
    evidence: z.array(
      z.object({
        path: z.string(),
        startLine: z.number(),
        endLine: z.number(),
        score: z.number(),
        breadcrumb: z.string(),
        text: z.string(),
      }),
    ),
  }),
});

export const promptContextInputSchema = z.object({
  prompt: z.string().min(1).describe('需要准备代码上下文的原始请求'),
  repo_path: z.string().min(1).optional().describe('可选的目标仓库绝对路径'),
  paths: z.array(z.string().min(1)).optional().describe('请求中明确出现的路径'),
  symbols: z.array(z.string().min(1)).optional().describe('请求中明确出现的符号'),
});

export const promptContextOutputSchema = z.object({
  status: z.enum(['ok', 'authorization_required', 'declined']),
  result: promptContextResultSchema.optional(),
  authorization: authorizationMetadataSchema.optional(),
});

export type PromptContextInput = z.infer<typeof promptContextInputSchema>;

export interface PromptContextDependencies extends AuthorizationDependencies {
  resolveRepositoryPath?: typeof resolveRepositoryPath;
  authorize?: typeof authorizeOrReturnRequired;

  buildPromptContext?: typeof defaultBuildPromptContext;
}

export function createPromptContextHandler(
  dependencies: PromptContextDependencies = {},
): (input: PromptContextInput, context: McpToolRequestContext) => Promise<CallToolResult> {
  return async (input, context) => {
    const progress = createMonotonicProgressForwarder(context);

    try {
      context.signal.throwIfAborted();
      let repoPath: string | undefined;
      let indexedNow = false;
      if (input.repo_path) {
        repoPath = await (dependencies.resolveRepositoryPath ?? resolveRepositoryPath)(
          input.repo_path,
          context,
        );
        const authorization = await (dependencies.authorize ?? authorizeOrReturnRequired)(
          repoPath,
          context,
          progress.report,
          dependencies,
        );
        if (authorization.status !== 'ready') {
          return toBusinessToolResult(authorization);
        }
        indexedNow = authorization.indexedNow === true;
      }

      context.signal.throwIfAborted();
      const buildPromptContext = dependencies.buildPromptContext ?? defaultBuildPromptContext;
      const result: PromptContextResult = await buildPromptContext({
        prompt: input.prompt,
        repoPath,
        explicitPaths: input.paths,
        explicitSymbols: input.symbols,
        ...(repoPath
          ? {
              onProgress: progress.report,
              signal: context.signal,
              skipBackgroundIndex: indexedNow,
            }
          : {}),
      });

      if (repoPath && result.retrieval.status === 'error') {
        throw new Error(result.retrieval.error || '仓库上下文检索失败');
      }

      return toBusinessToolResult({ status: 'ok', result });
    } catch (error) {
      return toErrorToolResult(sanitizeErrorMessage(error));
    } finally {
      await progress.complete();
    }
  };
}
