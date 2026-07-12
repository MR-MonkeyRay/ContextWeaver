import type { ElicitRequestFormParams, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import {
  ensureSearchableProject as defaultEnsureSearchableProject,
  runIndexCommand as defaultRunIndexCommand,
  IndexAlreadyConfirmedError,
  IndexAuthorizationRequiredError,
  type IndexConfirmationContext,
  IndexConfirmationDeclinedError,
} from '../cli.js';
import {
  type AuthorizationMetadata,
  type AuthorizationReason,
  sanitizeSensitiveText,
} from './result.js';

function replaceControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 ? ' ' : character;
  }).join('');
}

export interface ProviderDisclosure {
  embedding: { origin: string; model: string };
  reranker: { origin: string; model: string };
}

export interface ProgressUpdate {
  progress: number;
  total?: number;
  message?: string;
}

export interface McpToolRequestContext {
  signal: AbortSignal;
  rootsAdvertised: boolean;
  listRoots?: () => Promise<Array<{ uri: string; name?: string }>>;
  supportsFormElicitation: boolean;
  elicit?: (
    params: ElicitRequestFormParams,
    options?: { signal?: AbortSignal },
  ) => Promise<ElicitResult>;
  progressToken?: string | number;
  sendProgress?: (update: ProgressUpdate) => Promise<void>;
}

export type AuthorizationOutcome =
  | { status: 'ready'; indexedNow?: boolean }
  | {
      status: 'authorization_required' | 'declined';
      authorization: AuthorizationMetadata;
    };

export interface AuthorizationDependencies {
  ensureSearchableProject?: typeof defaultEnsureSearchableProject;
  runIndexCommand?: typeof defaultRunIndexCommand;
  getProviderDisclosure?: () => ProviderDisclosure;
}

export interface MonotonicProgressForwarder {
  report(current: number, total?: number, message?: string): void;
  complete(): Promise<void>;
}

function cleanDisplayValue(value: string | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }
  return replaceControlCharacters(value).trim().slice(0, 300) || fallback;
}

function sanitizeProviderOrigin(value: string | undefined): string {
  if (!value) {
    return '<未配置>';
  }

  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
      return '<无效端点>';
    }
    return endpoint.origin;
  } catch {
    return '<无效端点>';
  }
}

function getDefaultProviderDisclosure(): ProviderDisclosure {
  return {
    embedding: {
      origin: sanitizeProviderOrigin(process.env.EMBEDDINGS_BASE_URL),
      model: cleanDisplayValue(process.env.EMBEDDINGS_MODEL, '<未配置>'),
    },
    reranker: {
      origin: sanitizeProviderOrigin(process.env.RERANK_BASE_URL),
      model: cleanDisplayValue(process.env.RERANK_MODEL, '<未配置>'),
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

export function buildCliFallbackCommand(repoPath: string): string {
  return `cw index ${shellQuote(repoPath)}`;
}

function createAuthorizationMetadata(
  repoPath: string,
  reason: AuthorizationReason,
): AuthorizationMetadata {
  return {
    repoPath,
    reason,
    message:
      reason === 'elicitation_unsupported'
        ? '当前 MCP 客户端不支持 Form Elicitation；首次索引必须通过 CLI 明确确认。'
        : '首次索引未获得 Elicitation 客户端授权响应，未扫描仓库。',
    cliExecutable: 'cw',
    cliArgs: ['index', repoPath],
    cliCommand: buildCliFallbackCommand(repoPath),
    cliCommandShell: 'posix',
  };
}

function appendSummary(lines: string[], title: string, values: string[], maxItems = 20): void {
  lines.push(title);
  for (const value of values.slice(0, maxItems)) {
    lines.push(`- ${cleanDisplayValue(value, '<空>')}`);
  }
  if (values.length > maxItems) {
    lines.push(`- ... 另有 ${values.length - maxItems} 项`);
  }
}

export function buildAuthorizationPrompt(
  context: IndexConfirmationContext,
  providers: ProviderDisclosure,
): string {
  const lines = [
    'ContextWeaver 请求首次索引授权。',
    '',
    `仓库: ${cleanDisplayValue(context.rootPath, '<未知>')}`,
    `实际匹配: ${context.preview.totalFiles} 个文件`,
    `项目配置: ${context.projectConfigCreated ? '本次已创建 cwconfig.json' : '使用现有 cwconfig.json'}`,
    '',
    ...context.scopeLines.map((line) => cleanDisplayValue(line, '<空>')),
    '',
  ];

  appendSummary(lines, '目录摘要:', context.preview.directorySummaries);
  appendSummary(lines, '路径样本:', context.preview.samplePaths, 10);
  lines.push(
    '',
    `Embedding: ${providers.embedding.origin} / ${providers.embedding.model}`,
    `Reranker: ${providers.reranker.origin} / ${providers.reranker.model}`,
    '',
    '授权后，匹配范围内的代码片段将发送到上述外部 Embedding/Reranker 服务。',
    '只有 Elicitation 响应为 accept 且“允许首次索引”为 true 时才会开始扫描。',
  );

  return sanitizeSensitiveText(lines.join('\n'), { preserveLineBreaks: true });
}

export function createMonotonicProgressForwarder(
  context: Pick<McpToolRequestContext, 'progressToken' | 'sendProgress'>,
): MonotonicProgressForwarder {
  let lastProgress = Number.NEGATIVE_INFINITY;
  let completed = false;
  const pending = new Set<Promise<void>>();

  return {
    report(current, total, message) {
      if (
        completed ||
        context.progressToken === undefined ||
        !context.sendProgress ||
        !Number.isFinite(current) ||
        current <= lastProgress
      ) {
        return;
      }

      lastProgress = current;
      const update: ProgressUpdate = { progress: current };
      if (total !== undefined && Number.isFinite(total)) {
        update.total = total;
      }
      if (message) {
        update.message = cleanDisplayValue(message, '');
      }

      let notification: Promise<void>;
      try {
        notification = Promise.resolve(context.sendProgress(update)).catch(() => {});
      } catch {
        return;
      }
      pending.add(notification);
      void notification.finally(() => pending.delete(notification));
    },
    async complete() {
      completed = true;
      await Promise.allSettled([...pending]);
    },
  };
}

interface PendingFirstIndexAuthorization {
  operation: Promise<AuthorizationOutcome>;
  ownerSignal: AbortSignal;
}

const pendingFirstIndexAuthorizations = new Map<string, PendingFirstIndexAuthorization>();

function waitForAuthorization(
  operation: Promise<AuthorizationOutcome>,
  signal: AbortSignal,
): Promise<AuthorizationOutcome> {
  signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      try {
        signal.throwIfAborted();
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void operation.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

async function markRecentlyIndexed(repoPath: string): Promise<void> {
  const { markBackgroundIndexFresh } = await import('../retrieval/index.js');
  markBackgroundIndexFresh(repoPath);
}

export async function authorizeOrReturnRequired(
  repoPath: string,
  context: McpToolRequestContext,
  onProgress: (current: number, total?: number, message?: string) => void,
  dependencies: AuthorizationDependencies = {},
): Promise<AuthorizationOutcome> {
  const ensureSearchableProject =
    dependencies.ensureSearchableProject ?? defaultEnsureSearchableProject;
  const runIndexCommand = dependencies.runIndexCommand ?? defaultRunIndexCommand;
  const getProviderDisclosure = dependencies.getProviderDisclosure ?? getDefaultProviderDisclosure;

  context.signal.throwIfAborted();
  try {
    await ensureSearchableProject(repoPath);
    return { status: 'ready' };
  } catch (error) {
    if (!(error instanceof IndexAuthorizationRequiredError)) {
      throw error;
    }
  }

  const pendingAuthorization = pendingFirstIndexAuthorizations.get(repoPath);
  if (pendingAuthorization) {
    try {
      return await waitForAuthorization(pendingAuthorization.operation, context.signal);
    } catch (error) {
      if (context.signal.aborted || !pendingAuthorization.ownerSignal.aborted) {
        throw error;
      }

      await pendingAuthorization.operation.catch(() => {});
      if (pendingFirstIndexAuthorizations.get(repoPath) === pendingAuthorization) {
        pendingFirstIndexAuthorizations.delete(repoPath);
      }
      return authorizeOrReturnRequired(repoPath, context, onProgress, dependencies);
    }
  }

  const elicit = context.elicit;
  if (!context.supportsFormElicitation || !elicit) {
    return {
      status: 'authorization_required',
      authorization: createAuthorizationMetadata(repoPath, 'elicitation_unsupported'),
    };
  }

  const operation = (async (): Promise<AuthorizationOutcome> => {
    let declinedReason: AuthorizationReason | undefined;
    let elicitationCalled = false;

    try {
      await runIndexCommand({
        rootPath: repoPath,
        force: false,
        isInteractive: false,
        signal: context.signal,
        skipIfAlreadyConfirmed: true,
        onProgress,
        confirmIndex: async (confirmationContext) => {
          context.signal.throwIfAborted();
          if (elicitationCalled) {
            throw new Error('首次索引确认回调被重复调用');
          }
          elicitationCalled = true;

          let stillRequiresAuthorization = false;
          try {
            await ensureSearchableProject(repoPath);
          } catch (error) {
            if (!(error instanceof IndexAuthorizationRequiredError)) {
              throw error;
            }
            stillRequiresAuthorization = true;
          }
          if (!stillRequiresAuthorization) {
            throw new IndexAlreadyConfirmedError();
          }

          let response: ElicitResult;
          try {
            response = await elicit(
              {
                mode: 'form',
                message: buildAuthorizationPrompt(confirmationContext, getProviderDisclosure()),
                requestedSchema: {
                  type: 'object',
                  properties: {
                    approve: {
                      type: 'boolean',
                      title: '允许首次索引',
                      description: '允许扫描预览范围并将匹配代码片段发送到所显示的模型服务',
                      default: false,
                    },
                  },
                  required: ['approve'],
                },
              },
              { signal: context.signal },
            );
          } catch {
            context.signal.throwIfAborted();
            declinedReason = 'elicitation_failed';
            return false;
          }

          if (response.action === 'decline') {
            declinedReason = 'elicitation_declined';
            return false;
          }
          if (response.action === 'cancel') {
            declinedReason = 'elicitation_cancelled';
            return false;
          }
          if (
            response.action !== 'accept' ||
            !response.content ||
            typeof response.content !== 'object'
          ) {
            declinedReason = 'invalid_elicitation_response';
            return false;
          }
          if (response.content.approve !== true) {
            declinedReason =
              response.content.approve === false
                ? 'approval_false'
                : 'invalid_elicitation_response';
            return false;
          }

          context.signal.throwIfAborted();
          return true;
        },
      });
    } catch (error) {
      if (error instanceof IndexAlreadyConfirmedError) {
        await markRecentlyIndexed(repoPath);
        return { status: 'ready', indexedNow: true };
      }
      if (declinedReason && error instanceof IndexConfirmationDeclinedError) {
        return {
          status: 'declined',
          authorization: createAuthorizationMetadata(repoPath, declinedReason),
        };
      }
      throw error;
    }

    await markRecentlyIndexed(repoPath);
    return { status: 'ready', indexedNow: true };
  })();

  const pendingEntry: PendingFirstIndexAuthorization = {
    operation,
    ownerSignal: context.signal,
  };
  pendingFirstIndexAuthorizations.set(repoPath, pendingEntry);
  void operation
    .finally(() => {
      if (pendingFirstIndexAuthorizations.get(repoPath) === pendingEntry) {
        pendingFirstIndexAuthorizations.delete(repoPath);
      }
    })
    .catch(() => {});

  return waitForAuthorization(operation, context.signal);
}
