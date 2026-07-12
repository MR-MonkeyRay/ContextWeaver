import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolRequestContext } from './authorization.js';
import {
  type CodebaseRetrievalDependencies,
  codebaseRetrievalInputSchema,
  codebaseRetrievalOutputSchema,
  createCodebaseRetrievalHandler,
} from './tools/codebaseRetrieval.js';
import {
  createPromptContextHandler,
  type PromptContextDependencies,
  promptContextInputSchema,
  promptContextOutputSchema,
} from './tools/promptContext.js';

export interface ContextWeaverMcpServerOptions {
  codebaseRetrieval?: CodebaseRetrievalDependencies;
  promptContext?: PromptContextDependencies;
}

function createRequestContext(
  mcpServer: McpServer,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): McpToolRequestContext {
  const capabilities = mcpServer.server.getClientCapabilities();
  const rootsAdvertised = capabilities?.roots !== undefined;
  const supportsFormElicitation = capabilities?.elicitation?.form !== undefined;
  const progressToken = extra._meta?.progressToken;

  return {
    signal: extra.signal,
    rootsAdvertised,
    supportsFormElicitation,
    ...(rootsAdvertised
      ? {
          listRoots: async () =>
            (await mcpServer.server.listRoots(undefined, { signal: extra.signal })).roots,
        }
      : {}),
    ...(supportsFormElicitation
      ? {
          elicit: (params, options) => mcpServer.server.elicitInput(params, options),
        }
      : {}),
    ...(progressToken !== undefined
      ? {
          progressToken,
          sendProgress: (update) =>
            extra.sendNotification({
              method: 'notifications/progress',
              params: {
                progressToken,
                ...update,
              },
            }),
        }
      : {}),
  };
}

export function createContextWeaverMcpServer(
  options: ContextWeaverMcpServerOptions = {},
): McpServer {
  const mcpServer = new McpServer(
    {
      name: 'contextweaver',
      version: '1.3.7',
    },
    {
      instructions:
        '在理解或修改代码前使用 codebase-retrieval；需要整理请求证据时使用 prepare-prompt-context。首次索引只接受 Form Elicitation 客户端授权响应。',
    },
  );

  const codebaseRetrieval = createCodebaseRetrievalHandler(options.codebaseRetrieval);
  mcpServer.registerTool(
    'codebase-retrieval',
    {
      title: '检索代码库上下文',
      description:
        '对已确认仓库执行语义检索。首次索引会通过 Form Elicitation 展示实际范围；客户端不支持时返回 CLI 确认命令。',
      inputSchema: codebaseRetrievalInputSchema,
      outputSchema: codebaseRetrievalOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (input, extra) => codebaseRetrieval(input, createRequestContext(mcpServer, extra)),
  );

  const promptContext = createPromptContextHandler(options.promptContext);
  mcpServer.registerTool(
    'prepare-prompt-context',
    {
      title: '准备 Prompt 代码证据',
      description:
        '提取请求中的路径和符号，并可从已确认仓库检索证据。无 repo_path 时只做本地 Prompt 分析。',
      inputSchema: promptContextInputSchema,
      outputSchema: promptContextOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (input, extra) => promptContext(input, createRequestContext(mcpServer, extra)),
  );

  return mcpServer;
}

export async function startMcpServer(): Promise<void> {
  const server = createContextWeaverMcpServer();
  await server.connect(new StdioServerTransport());
}
