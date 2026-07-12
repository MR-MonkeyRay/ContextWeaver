import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface McpRoot {
  uri: string;
  name?: string;
}

export interface RepositoryPathPolicyOptions {
  rootsAdvertised: boolean;
  listRoots?: () => Promise<McpRoot[]>;
  homePath?: string;
  realpath?: (targetPath: string) => Promise<string>;
  stat?: (targetPath: string) => Promise<{ isDirectory(): boolean }>;
}

class RepositoryPathPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepositoryPathPolicyError';
  }
}

function isContainedBy(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function canonicalDirectory(
  targetPath: string,
  realpathFn: (targetPath: string) => Promise<string>,
  statFn: (targetPath: string) => Promise<{ isDirectory(): boolean }>,
): Promise<string | null> {
  try {
    const canonicalPath = await realpathFn(targetPath);
    const stats = await statFn(canonicalPath);
    return stats.isDirectory() ? canonicalPath : null;
  } catch {
    return null;
  }
}

export async function resolveRepositoryPath(
  repoPath: string,
  options: RepositoryPathPolicyOptions,
): Promise<string> {
  if (!path.isAbsolute(repoPath)) {
    throw new RepositoryPathPolicyError('repo_path 必须是绝对路径');
  }

  const realpathFn = options.realpath ?? fs.realpath;
  const statFn = options.stat ?? fs.stat;
  const canonicalRepoPath = await canonicalDirectory(repoPath, realpathFn, statFn);
  if (!canonicalRepoPath) {
    throw new RepositoryPathPolicyError('repo_path 必须指向真实存在的目录');
  }

  if (canonicalRepoPath === path.parse(canonicalRepoPath).root) {
    throw new RepositoryPathPolicyError('MCP 不允许将文件系统根目录作为仓库');
  }

  const configuredHomePath = options.homePath ?? os.homedir();
  const canonicalHomePath =
    (await canonicalDirectory(configuredHomePath, realpathFn, statFn)) ??
    path.resolve(configuredHomePath);
  if (canonicalRepoPath === canonicalHomePath) {
    throw new RepositoryPathPolicyError('MCP 不允许将用户主目录作为仓库');
  }

  if (!options.rootsAdvertised) {
    return canonicalRepoPath;
  }

  if (!options.listRoots) {
    throw new RepositoryPathPolicyError('客户端声明了 Roots，但无法读取 Roots 列表');
  }

  let roots: McpRoot[];
  try {
    roots = await options.listRoots();
  } catch {
    throw new RepositoryPathPolicyError('读取客户端 Roots 失败，已拒绝仓库访问');
  }

  if (!Array.isArray(roots) || roots.length === 0) {
    throw new RepositoryPathPolicyError('客户端 Roots 为空，已拒绝仓库访问');
  }

  const canonicalFileRoots: string[] = [];
  for (const root of roots) {
    if (!root || typeof root.uri !== 'string') {
      throw new RepositoryPathPolicyError('客户端返回了无效的 Root URL');
    }

    let rootUrl: URL;
    try {
      rootUrl = new URL(root.uri);
    } catch {
      throw new RepositoryPathPolicyError('客户端返回了无效的 Root URL');
    }

    if (rootUrl.protocol !== 'file:') {
      continue;
    }

    let decodedRootPath: string;
    try {
      decodedRootPath = fileURLToPath(rootUrl);
    } catch {
      throw new RepositoryPathPolicyError('客户端返回了无效的 file Root URL');
    }

    const canonicalRoot = await canonicalDirectory(decodedRootPath, realpathFn, statFn);
    if (canonicalRoot) {
      canonicalFileRoots.push(canonicalRoot);
    }
  }

  if (canonicalFileRoots.length === 0) {
    throw new RepositoryPathPolicyError('客户端未提供可用的 file Root，已拒绝仓库访问');
  }

  if (!canonicalFileRoots.some((rootPath) => isContainedBy(rootPath, canonicalRepoPath))) {
    throw new RepositoryPathPolicyError('repo_path 不在客户端授权的 Roots 范围内');
  }

  return canonicalRepoPath;
}
