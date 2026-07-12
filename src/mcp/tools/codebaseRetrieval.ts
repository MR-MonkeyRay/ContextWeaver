import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  retrieveCodeContext as defaultRetrieveCodeContext,
  type SearchResult,
} from '../../retrieval/index.js';
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

const searchSegmentSchema = z.object({
  startLine: z.number(),
  endLine: z.number(),
  score: z.number(),
  language: z.string(),
  breadcrumb: z.string(),
  text: z.string(),
});

const searchResultSchema = z.object({
  summary: z.object({
    query: z.string(),
    seedCount: z.number(),
    expandedCount: z.number(),
    fileCount: z.number(),
    totalSegments: z.number(),
  }),
  files: z.array(
    z.object({
      path: z.string(),
      segments: z.array(searchSegmentSchema),
    }),
  ),
});

export const codebaseRetrievalInputSchema = z.object({
  repo_path: z.string().min(1).describe('目标仓库的绝对路径'),
  information_request: z.string().min(1).describe('要理解的功能、流程或代码关系'),
  technical_terms: z.array(z.string().min(1)).optional().describe('少量精确符号或术语'),
});

export const codebaseRetrievalOutputSchema = z.object({
  status: z.enum(['ok', 'authorization_required', 'declined']),
  result: searchResultSchema.optional(),
  authorization: authorizationMetadataSchema.optional(),
});

export type CodebaseRetrievalInput = z.infer<typeof codebaseRetrievalInputSchema>;

export interface CodebaseRetrievalDependencies extends AuthorizationDependencies {
  resolveRepositoryPath?: typeof resolveRepositoryPath;
  authorize?: typeof authorizeOrReturnRequired;
  retrieveCodeContext?: typeof defaultRetrieveCodeContext;
}

export function createCodebaseRetrievalHandler(
  dependencies: CodebaseRetrievalDependencies = {},
): (input: CodebaseRetrievalInput, context: McpToolRequestContext) => Promise<CallToolResult> {
  return async (input, context) => {
    const progress = createMonotonicProgressForwarder(context);

    try {
      context.signal.throwIfAborted();
      const repoPath = await (dependencies.resolveRepositoryPath ?? resolveRepositoryPath)(
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

      context.signal.throwIfAborted();
      const result: SearchResult = await (
        dependencies.retrieveCodeContext ?? defaultRetrieveCodeContext
      )(
        {
          repoPath,
          informationRequest: input.information_request,
          technicalTerms: input.technical_terms,
        },
        {
          onProgress: progress.report,
          signal: context.signal,
          skipBackgroundIndex: authorization.indexedNow === true,
        },
      );

      return toBusinessToolResult({ status: 'ok', result });
    } catch (error) {
      return toErrorToolResult(sanitizeErrorMessage(error));
    } finally {
      await progress.complete();
    }
  };
}
