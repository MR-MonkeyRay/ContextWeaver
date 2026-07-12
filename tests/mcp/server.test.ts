import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createContextWeaverMcpServer } from '../../src/mcp/server.js';

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

describe('ContextWeaver MCP server', () => {
  it('advertises both tools with input and output schemas', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createContextWeaverMcpServer();
    const client = new Client(
      { name: 'contextweaver-test-client', version: '1.0.0' },
      { capabilities: {} },
    );
    closeCallbacks.push(
      () => client.close(),
      () => server.close(),
    );

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();

    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      'codebase-retrieval',
      'prepare-prompt-context',
    ]);
    for (const tool of listed.tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.outputSchema?.type).toBe('object');
      expect(tool.outputSchema?.properties).toHaveProperty('status');
    }

    const response = await client.callTool({
      name: 'prepare-prompt-context',
      arguments: { prompt: 'Refactor `SearchService`.' },
    });
    expect(response.structuredContent).toMatchObject({ status: 'ok' });
  });
});
