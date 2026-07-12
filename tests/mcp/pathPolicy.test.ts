import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveRepositoryPath } from '../../src/mcp/pathPolicy.js';

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('MCP repository path policy', () => {
  it('requires an existing absolute directory and rejects root/home targets', async () => {
    const home = await createTempDir('cw-mcp-home-');
    const file = path.join(home, 'file.ts');
    await fs.writeFile(file, 'export {}\n');

    await expect(
      resolveRepositoryPath('relative/repo', { rootsAdvertised: false, homePath: home }),
    ).rejects.toThrow('绝对路径');
    await expect(
      resolveRepositoryPath(path.join(home, 'missing'), {
        rootsAdvertised: false,
        homePath: home,
      }),
    ).rejects.toThrow('真实存在的目录');
    await expect(
      resolveRepositoryPath(file, { rootsAdvertised: false, homePath: home }),
    ).rejects.toThrow('真实存在的目录');
    await expect(
      resolveRepositoryPath(path.parse(home).root, {
        rootsAdvertised: false,
        homePath: home,
      }),
    ).rejects.toThrow('根目录');
    await expect(
      resolveRepositoryPath(home, { rootsAdvertised: false, homePath: home }),
    ).rejects.toThrow('主目录');
  });

  it('canonicalizes repository symlinks and decodes file Roots', async () => {
    const workspace = await createTempDir('cw-mcp-root with space-');
    const repo = path.join(workspace, 'repo');
    const link = path.join(workspace, 'repo-link');
    await fs.mkdir(repo);
    await fs.symlink(repo, link, 'dir');

    await expect(
      resolveRepositoryPath(link, {
        rootsAdvertised: true,
        listRoots: async () => [{ uri: pathToFileURL(workspace).href }],
      }),
    ).resolves.toBe(await fs.realpath(repo));
  });

  it('uses canonical containment instead of vulnerable string prefixes', async () => {
    const parent = await createTempDir('cw-mcp-sibling-');
    const root = path.join(parent, 'project');
    const sibling = path.join(parent, 'project-secret');
    await fs.mkdir(root);
    await fs.mkdir(sibling);

    await expect(
      resolveRepositoryPath(sibling, {
        rootsAdvertised: true,
        listRoots: async () => [{ uri: pathToFileURL(root).href }],
      }),
    ).rejects.toThrow('Roots 范围');
  });

  it('fails closed for advertised Roots failures, empty/unusable roots, and malformed URLs', async () => {
    const repo = await createTempDir('cw-mcp-repo-');

    await expect(
      resolveRepositoryPath(repo, {
        rootsAdvertised: true,
        listRoots: async () => {
          throw new Error('client disconnected');
        },
      }),
    ).rejects.toThrow('读取客户端 Roots 失败');
    await expect(
      resolveRepositoryPath(repo, { rootsAdvertised: true, listRoots: async () => [] }),
    ).rejects.toThrow('Roots 为空');
    await expect(
      resolveRepositoryPath(repo, {
        rootsAdvertised: true,
        listRoots: async () => [{ uri: 'https://example.com/repo' }],
      }),
    ).rejects.toThrow('未提供可用');
    await expect(
      resolveRepositoryPath(repo, {
        rootsAdvertised: true,
        listRoots: async () => [{ uri: 'not a url' }],
      }),
    ).rejects.toThrow('无效的 Root URL');
  });
});
