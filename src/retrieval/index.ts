import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProjectIdentity } from '../db/index.js';
import type { ContextPack, SearchConfig, Segment } from '../search/types.js';
import { logger } from '../utils/logger.js';

export interface SearchSummary {
  query: string;
  seedCount: number;
  expandedCount: number;
  fileCount: number;
  totalSegments: number;
}

export interface SearchResultSegment {
  startLine: number;
  endLine: number;
  score: number;
  language: string;
  breadcrumb: string;
  text: string;
}

export interface SearchResultFile {
  path: string;
  segments: SearchResultSegment[];
}

export interface SearchResult {
  summary: SearchSummary;
  files: SearchResultFile[];
}

export interface RetrievalInput {
  repoPath: string;
  informationRequest: string;
  technicalTerms?: string[];
}

export type SearchOutputFormat = 'text' | 'json';

const BASE_DIR = path.join(os.homedir(), '.contextweaver');
const INDEX_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const BACKGROUND_INDEX_COOLDOWN_MS = 60 * 1000;
const backgroundIndexStartedAt = new Map<string, number>();

async function ensureDefaultEnvFile(): Promise<void> {
  const configDir = BASE_DIR;
  const envFile = path.join(configDir, '.env');

  if (fs.existsSync(envFile)) {
    return;
  }

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
    logger.info({ configDir }, '创建配置目录');
  }

  const defaultEnvContent = `# ContextWeaver 示例环境变量配置文件

# Embedding API 配置（必需）
EMBEDDINGS_API_KEY=your-api-key-here
EMBEDDINGS_BASE_URL=https://api.siliconflow.cn/v1/embeddings
EMBEDDINGS_MODEL=BAAI/bge-m3
EMBEDDINGS_MAX_CONCURRENCY=10
EMBEDDINGS_DIMENSIONS=1024
EMBEDDINGS_MAX_INPUT_TOKENS=8192

# Reranker 配置（必需）
RERANK_API_KEY=your-api-key-here
RERANK_BASE_URL=https://api.siliconflow.cn/v1/rerank
RERANK_MODEL=BAAI/bge-reranker-v2-m3
RERANK_TOP_N=20
`;

  fs.writeFileSync(envFile, defaultEnvContent);
  logger.info({ envFile }, '已创建默认 .env 配置文件');
}

function isProjectIndexed(projectId: string): boolean {
  const dbPath = path.join(BASE_DIR, projectId, 'index.db');
  return fs.existsSync(dbPath);
}

function getBackgroundIndexRequestPath(projectId: string): string {
  return path.join(BASE_DIR, projectId, 'background-index.request');
}

function claimBackgroundIndexRequest(projectId: string): string | null {
  const requestPath = getBackgroundIndexRequestPath(projectId);
  const dir = path.dirname(requestPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  try {
    const content = fs.readFileSync(requestPath, 'utf-8');
    const requestInfo = JSON.parse(content) as { pid: number; timestamp: number };
    if (Date.now() - requestInfo.timestamp < BACKGROUND_INDEX_COOLDOWN_MS) {
      return null;
    }
  } catch {
    // 文件不存在或损坏时，继续重建预约文件
  }

  try {
    fs.unlinkSync(requestPath);
  } catch {
    // 允许文件不存在
  }

  try {
    fs.writeFileSync(requestPath, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), {
      flag: 'wx',
    });
    return requestPath;
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code !== 'EEXIST') {
      logger.debug({ error: error.message }, '创建后台索引请求标记失败');
    }
    return null;
  }
}

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function findPackageRoot(startDir: string): string | null {
  let currentDir = startDir;

  while (true) {
    const packageJsonPath = path.join(currentDir, 'package.json');
    if (fileExists(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
          name?: string;
        };
        if (packageJson.name === '@monkeyray/contextweaver') {
          return currentDir;
        }
      } catch {
        // package.json 损坏时继续向上查找，避免误用未知入口
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

function resolveExistingPath(candidatePath: string): string | null {
  const resolvedPath = path.resolve(candidatePath);
  return fileExists(resolvedPath) ? resolvedPath : null;
}

function resolveEnvCliEntryPath(): string | null {
  const overridePath = process.env.CONTEXTWEAVER_CLI_ENTRY || process.env.CW_CLI_ENTRY;
  if (!overridePath) {
    return null;
  }

  return resolveExistingPath(overridePath);
}

function isContextWeaverCliEntry(candidatePath: string, packageRoot: string): boolean {
  const realCandidate = fs.realpathSync(candidatePath);
  const allowedEntries = [
    path.join(packageRoot, 'dist', 'index.js'),
    path.join(packageRoot, 'src', 'index.js'),
    path.join(packageRoot, 'src', 'index.ts'),
  ]
    .filter(fileExists)
    .map((entryPath) => fs.realpathSync(entryPath));

  return allowedEntries.includes(realCandidate);
}

function resolveCliEntryPath(): string {
  const envEntryPath = resolveEnvCliEntryPath();
  if (envEntryPath) {
    return envEntryPath;
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = findPackageRoot(moduleDir);
  if (!packageRoot) {
    throw new Error('无法定位 ContextWeaver package root，跳过后台索引');
  }

  const invokedPath = process.argv[1];
  if (invokedPath && fileExists(invokedPath) && isContextWeaverCliEntry(invokedPath, packageRoot)) {
    return fs.realpathSync(invokedPath);
  }

  const candidates = [
    path.join(packageRoot, 'dist', 'index.js'),
    path.join(packageRoot, 'src', 'index.js'),
    path.join(packageRoot, 'src', 'index.ts'),
  ];

  for (const candidate of candidates) {
    const entryPath = resolveExistingPath(candidate);
    if (entryPath) {
      return entryPath;
    }
  }

  throw new Error('无法定位 ContextWeaver CLI 入口，跳过后台索引');
}

async function ensureIndexed(
  repoPath: string,
  projectId: string,
  onProgress?: (current: number, total?: number, message?: string) => void,
): Promise<void> {
  const { withLock } = await import('../utils/lock.js');
  const { scan } = await import('../scanner/index.js');

  await withLock(
    projectId,
    'index',
    async () => {
      const wasIndexed = isProjectIndexed(projectId);

      if (!wasIndexed) {
        logger.info(
          { repoPath, projectId: projectId.slice(0, 10) },
          '代码库未初始化，开始首次索引...',
        );
        onProgress?.(0, 100, '代码库未索引，开始首次索引...');
      }

      const startTime = Date.now();
      const stats = await scan(repoPath, { vectorIndex: true, onProgress });
      const elapsed = Date.now() - startTime;

      logger.info(
        {
          projectId: projectId.slice(0, 10),
          isFirstTime: !wasIndexed,
          totalFiles: stats.totalFiles,
          added: stats.added,
          modified: stats.modified,
          deleted: stats.deleted,
          vectorIndex: stats.vectorIndex,
          elapsedMs: elapsed,
        },
        '索引完成',
      );
    },
    INDEX_LOCK_TIMEOUT_MS,
  );
}

export async function scheduleBackgroundIndex(repoPath: string, projectId: string): Promise<void> {
  const lastStartedAt = backgroundIndexStartedAt.get(projectId) ?? 0;
  if (Date.now() - lastStartedAt < BACKGROUND_INDEX_COOLDOWN_MS) {
    return;
  }

  const { isProjectLocked } = await import('../utils/lock.js');
  if (isProjectLocked(projectId)) {
    logger.debug({ projectId: projectId.slice(0, 10) }, '后台索引已在进行中，跳过重复调度');
    return;
  }

  const requestPath = claimBackgroundIndexRequest(projectId);
  if (!requestPath) {
    logger.debug({ projectId: projectId.slice(0, 10) }, '后台索引请求已被其他进程预约');
    return;
  }

  backgroundIndexStartedAt.set(projectId, Date.now());

  try {
    const cliEntry = resolveCliEntryPath();
    const child = spawn(process.execPath, [cliEntry, 'index', repoPath, '--yes'], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        CW_BACKGROUND_INDEX: '1',
        CW_INDEX_LOCK_TIMEOUT_MS: '500',
        CW_BACKGROUND_INDEX_MARKER_PATH: requestPath,
      },
    });

    child.unref();
    logger.info({ projectId: projectId.slice(0, 10), pid: child.pid }, '已启动后台增量索引');
  } catch (err) {
    try {
      fs.unlinkSync(requestPath);
    } catch {
      // 忽略清理失败
    }
    throw err;
  }
}

export function buildSearchResult(pack: ContextPack): SearchResult {
  return {
    summary: {
      query: pack.query,
      seedCount: pack.seeds.length,
      expandedCount: pack.expanded.length,
      fileCount: pack.files.length,
      totalSegments: pack.files.reduce((acc, file) => acc + file.segments.length, 0),
    },
    files: pack.files.map((file) => ({
      path: file.filePath,
      segments: file.segments.map((segment) => buildSearchResultSegment(segment)),
    })),
  };
}

function buildSearchResultSegment(segment: Segment): SearchResultSegment {
  return {
    startLine: segment.startLine,
    endLine: segment.endLine,
    score: segment.score,
    language: detectSegmentLanguage(segment.filePath),
    breadcrumb: segment.breadcrumb,
    text: segment.text,
  };
}

export function renderSearchResult(result: SearchResult, format: SearchOutputFormat): string {
  if (format === 'json') {
    return `${JSON.stringify(result, null, 2)}\n`;
  }

  const fileBlocks = result.files
    .map((file) =>
      file.segments
        .map((segment) => {
          const header = `## ${file.path} (L${segment.startLine}-${segment.endLine})`;
          const breadcrumb = segment.breadcrumb ? `> ${segment.breadcrumb}` : '';
          const code = `\`\`\`${segment.language}\n${segment.text}\n\`\`\``;
          return [header, breadcrumb, code].filter(Boolean).join('\n');
        })
        .join('\n\n'),
    )
    .join('\n\n---\n\n');

  const summary = [
    `Found ${result.summary.seedCount} relevant code blocks`,
    `Files: ${result.summary.fileCount}`,
    `Total segments: ${result.summary.totalSegments}`,
  ].join(' | ');

  return `${summary}\n\n${fileBlocks}\n`;
}

export async function retrieveCodeContext(
  input: RetrievalInput,
  options?: {
    onProgress?: (current: number, total?: number, message?: string) => void;
    configOverride?: Partial<SearchConfig>;
  },
): Promise<SearchResult> {
  const { checkEmbeddingEnv, checkRerankerEnv } = await import('../config.js');
  const embeddingCheck = checkEmbeddingEnv();
  const rerankerCheck = checkRerankerEnv();
  const allMissingVars = [...embeddingCheck.missingVars, ...rerankerCheck.missingVars];

  if (allMissingVars.length > 0) {
    await ensureDefaultEnvFile();
    throw new Error(`ContextWeaver 环境变量未配置: ${allMissingVars.join(', ')}`);
  }

  const projectId = getProjectIdentity(input.repoPath).projectId;
  if (!isProjectIndexed(projectId)) {
    await ensureIndexed(input.repoPath, projectId, options?.onProgress);
  } else {
    logger.debug({ projectId: projectId.slice(0, 10) }, '命中已有索引，跳过同步增量索引');
    void scheduleBackgroundIndex(input.repoPath, projectId).catch((err) => {
      const error = err as { message?: string };
      logger.warn({ projectId: projectId.slice(0, 10), error: error.message }, '启动后台索引失败');
    });
  }

  const query = [input.informationRequest, ...(input.technicalTerms || [])]
    .filter(Boolean)
    .join(' ');

  const { SearchService } = await import('../search/SearchService.js');
  const service = new SearchService(projectId, input.repoPath, options?.configOverride);
  try {
    await service.init();
    const pack = await service.buildContextPack(query);
    return buildSearchResult(pack);
  } finally {
    service.close();
  }
}

function detectSegmentLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    csx: 'csharp',
    rb: 'ruby',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    kts: 'kotlin',
    dart: 'dart',
    scala: 'scala',
    sql: 'sql',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    md: 'markdown',
    toml: 'toml',
  };
  return langMap[ext] || ext || 'plaintext';
}
