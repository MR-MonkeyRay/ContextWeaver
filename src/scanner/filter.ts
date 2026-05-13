import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ignore from 'ignore';
import { getExcludePatterns } from '../config.js';
import { loadProjectConfig } from '../projectConfig.js';
import { isAllowedExtension } from './language.js';

let includeInstance: ignore.Ignore | null = null;
let defaultIgnoreInstance: ignore.Ignore | null = null;
let projectIgnoreInstance: ignore.Ignore | null = null;
let gitignoreInstance: ignore.Ignore | null = null;
let includeAll = true;
let lastConfigHash: string | null = null;

function getXdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

function stripInlineComment(value: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (quote === '"' && char === '\\') {
      escaped = true;
      continue;
    }

    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
      continue;
    }

    if (char === quote) {
      quote = null;
      continue;
    }

    if (quote === null && (char === '#' || char === ';')) {
      return value.slice(0, index).trimEnd();
    }
  }

  return value.trimEnd();
}

function unquoteGitConfigValue(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
    return value;
  }

  let result = '';
  let escaped = false;

  for (const char of value.slice(1, -1)) {
    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    result += char;
  }

  if (escaped) {
    result += '\\';
  }

  return result;
}

function parseGitConfigCoreExcludesFile(content: string): string | null {
  let inCoreSection = false;
  let excludesFile: string | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line === '' || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }

    if (line.startsWith('[')) {
      inCoreSection = line.toLowerCase() === '[core]';
      continue;
    }

    if (!inCoreSection) {
      continue;
    }

    const match = line.match(/^excludesfile\s*=\s*(.*)$/i);
    if (!match) {
      continue;
    }

    const value = unquoteGitConfigValue(stripInlineComment(match[1]).trim());

    excludesFile = value || null;
  }

  return excludesFile;
}

function expandTilde(filePath: string): string {
  if (filePath === '~') {
    return os.homedir();
  }

  if (filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }

  return filePath;
}

async function readCoreExcludesFile(configPath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(configPath, 'utf-8');
    return parseGitConfigCoreExcludesFile(content);
  } catch {
    return null;
  }
}

/**
 * 解析 Git 全局忽略文件路径。
 *
 * Git 会按进程当前目录解析相对 core.excludesFile。扫描器入口可能来自任意目录，
 * 因此这里保守固定为仓库根目录，保证同一个仓库的过滤结果稳定。
 */
async function resolveGlobalGitIgnorePath(rootPath: string): Promise<string> {
  const configuredPath =
    (await readCoreExcludesFile(path.join(rootPath, '.git', 'config'))) ??
    (await readCoreExcludesFile(path.join(os.homedir(), '.gitconfig'))) ??
    (await readCoreExcludesFile(path.join(getXdgConfigHome(), 'git', 'config')));

  if (!configuredPath) {
    return path.join(getXdgConfigHome(), 'git', 'ignore');
  }

  const expandedPath = expandTilde(configuredPath);
  return path.isAbsolute(expandedPath) ? expandedPath : path.resolve(rootPath, expandedPath);
}

async function addFileHash(label: string, filePath: string, hashes: string[]): Promise<void> {
  const crypto = await import('node:crypto');

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    hashes.push(
      `${label}:${filePath}:${crypto.createHash('sha256').update(content).digest('hex')}`,
    );
  } catch {
    hashes.push(`${label}:${filePath}:missing`);
  }
}

/**
 * 生成配置文件内容的 hash
 */
async function generateConfigHash(rootPath: string): Promise<string> {
  const crypto = await import('node:crypto');
  const hashes: string[] = [];

  const configPath = path.join(rootPath, 'cwconfig.json');
  await addFileHash('cwconfig', configPath, hashes);

  const globalGitIgnorePath = await resolveGlobalGitIgnorePath(rootPath);
  await addFileHash('global-gitignore', globalGitIgnorePath, hashes);

  const gitignorePath = path.join(rootPath, '.gitignore');
  await addFileHash('gitignore', gitignorePath, hashes);

  // 合并所有 hashes
  const combined = hashes.join('|');
  return crypto.createHash('sha256').update(combined).digest('hex');
}

/**
 * 初始化过滤器
 */
export async function initFilter(rootPath: string): Promise<void> {
  const currentHash = await generateConfigHash(rootPath);

  if (
    lastConfigHash === currentHash &&
    defaultIgnoreInstance &&
    projectIgnoreInstance &&
    gitignoreInstance &&
    (includeAll || includeInstance)
  ) {
    return; // 配置未变更，复用实例
  }

  const projectConfig = await loadProjectConfig(rootPath);

  if (projectConfig.indexing.includePatterns === null) {
    includeAll = true;
    includeInstance = null;
  } else {
    includeAll = false;
    includeInstance = ignore().add(projectConfig.indexing.includePatterns);
  }

  defaultIgnoreInstance = ignore().add(getExcludePatterns());
  projectIgnoreInstance = ignore().add(projectConfig.indexing.ignorePatterns);

  const gitignore = ignore();

  // 加载全局 Git 忽略文件
  const globalGitIgnorePath = await resolveGlobalGitIgnorePath(rootPath);
  try {
    gitignore.add(await fs.readFile(globalGitIgnorePath, 'utf-8'));
  } catch {
    // 文件不存在，静默跳过
  }

  // 加载项目 .gitignore
  const gitignorePath = path.join(rootPath, '.gitignore');
  try {
    gitignore.add(await fs.readFile(gitignorePath, 'utf-8'));
  } catch {
    // 文件不存在，静默跳过
  }

  gitignoreInstance = gitignore;
  lastConfigHash = currentHash;
}

/**
 * 判断文件路径是否应该被过滤掉
 */
export function isFiltered(relativePath: string): boolean {
  if (!defaultIgnoreInstance || !projectIgnoreInstance || !gitignoreInstance) {
    throw new Error('Filter not initialized. Call initFilter() first.');
  }

  return (
    relativePath === 'cwconfig.json' ||
    defaultIgnoreInstance.ignores(relativePath) ||
    projectIgnoreInstance.ignores(relativePath) ||
    gitignoreInstance.ignores(relativePath)
  );
}

/**
 * 判断文件路径是否在项目配置的包含范围内
 */
export function isIncluded(relativePath: string): boolean {
  if (includeAll) {
    return true;
  }

  if (!includeInstance) {
    throw new Error('Filter not initialized. Call initFilter() first.');
  }

  return includeInstance.ignores(relativePath);
}

/**
 * 判断文件扩展名是否在白名单中
 */
export function isAllowedFile(filePath: string): boolean {
  return isAllowedExtension(filePath);
}
