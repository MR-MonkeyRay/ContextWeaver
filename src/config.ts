/**
 * 统一配置模块
 *
 * 整合环境变量加载、API 配置、排除模式等所有配置项
 *
 * 加载策略：
 * - 开发环境 (NODE_ENV !== "production"): 加载项目根目录的 .env 文件
 * - 生产环境 (NODE_ENV === "production"): 加载 ~/.contextweaver/.env 文件
 *
 * 此模块必须在应用启动时最先导入，以确保环境变量在其他模块加载前可用。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { ensurePrivateDirSync, hardenPrivatePathSync } from './utils/privateStorage.js';

// 环境变量加载

const isDev = process.env.NODE_ENV === 'dev';
const userConfigDir = path.join(os.homedir(), '.contextweaver');
const userEnvPath = path.join(userConfigDir, '.env');

// 兼容 logger 的非交互模式检测；MCP stdio 模式必须保持 stdout 为纯协议流。
export const isMcpMode = process.argv.includes('mcp');

function loadEnv(): void {
  // 可能的 .env 文件路径（按优先级排序）
  const candidates = isDev
    ? [
        path.join(process.cwd(), '.env'), // 1. 当前目录（开发用）
        userEnvPath, // 2. 用户配置目录（回退）
      ]
    : [
        userEnvPath, // 生产环境只用用户配置
      ];

  // 找到第一个存在的文件
  const envPath = candidates.find((p) => fs.existsSync(p));

  if (envPath) {
    if (envPath === userEnvPath) {
      ensurePrivateDirSync(userConfigDir);
      hardenPrivatePathSync(envPath);
    }

    const result = dotenv.config({ path: envPath, quiet: true });
    if (result.error) {
      // 环境变量加载失败是致命错误，此时 logger 尚未初始化，只能用 console
      console.error(`[config] 加载环境变量失败: ${result.error.message}`);
      process.exit(1);
    }
  }
  // 所有路径都不存在时静默跳过，允许无 .env 文件运行
}

// 立即执行加载
loadEnv();

// API 配置类型定义

export interface EmbeddingConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  batchSize: number;
  maxConcurrency: number;
  /** 网络/超时类错误重试次数 */
  networkRetries: number;
  /** 重试基础等待时间（毫秒） */
  retryBaseDelayMs: number;
  /** 每次重试额外增加的等待时间（毫秒）；0 表示关闭递增等待 */
  retryIntervalIncrementMs: number;
  /** 单次 Embedding 请求超时时间（毫秒）；0 表示不启用显式超时 */
  requestTimeoutMs: number;
  /** 每个索引窗口最多处理的 embedding item 数 */
  windowSize: number;
  /** 向量维度 */
  dimensions: number;
  /** 模型最大输入 token 数，超过此值的文本会在请求前截断 */
  maxInputTokens: number;
  /** 语义分片最大大小 */
  chunkMaxSize: number;
  /** 语义分片最小大小 */
  chunkMinSize: number;
  /** 语义分片重叠大小 */
  chunkOverlap: number;
}

export interface RerankerConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  topN: number;
}

export interface ChunkingConfig {
  /** 语义分片最大大小 */
  chunkMaxSize: number;
  /** 语义分片最小大小 */
  chunkMinSize: number;
  /** 语义分片重叠大小 */
  chunkOverlap: number;
}

// API 配置获取

/**
 * 环境变量检查结果
 */
export interface EnvCheckResult {
  isValid: boolean;
  missingVars: string[];
}

/**
 * 默认的 API Key 占位符（未修改则视为未配置）
 */
const DEFAULT_API_KEY_PLACEHOLDER = 'your-api-key-here';

/**
 * 检查 Embedding 相关环境变量是否已配置（不抛出错误）
 * @returns 检查结果，包含是否有效和缺失的变量列表
 */
export function checkEmbeddingEnv(): EnvCheckResult {
  const missingVars: string[] = [];

  const apiKey = process.env.EMBEDDINGS_API_KEY;
  if (!apiKey || apiKey === DEFAULT_API_KEY_PLACEHOLDER) {
    missingVars.push('EMBEDDINGS_API_KEY');
  }
  if (!process.env.EMBEDDINGS_BASE_URL) {
    missingVars.push('EMBEDDINGS_BASE_URL');
  }
  if (!process.env.EMBEDDINGS_MODEL) {
    missingVars.push('EMBEDDINGS_MODEL');
  }

  return {
    isValid: missingVars.length === 0,
    missingVars,
  };
}

/**
 * 检查 Reranker 相关环境变量是否已配置（不抛出错误）
 * @returns 检查结果，包含是否有效和缺失的变量列表
 */
export function checkRerankerEnv(): EnvCheckResult {
  const missingVars: string[] = [];

  const apiKey = process.env.RERANK_API_KEY;
  if (!apiKey || apiKey === DEFAULT_API_KEY_PLACEHOLDER) {
    missingVars.push('RERANK_API_KEY');
  }
  if (!process.env.RERANK_BASE_URL) {
    missingVars.push('RERANK_BASE_URL');
  }
  if (!process.env.RERANK_MODEL) {
    missingVars.push('RERANK_MODEL');
  }

  return {
    isValid: missingVars.length === 0,
    missingVars,
  };
}

/**
 * 获取 Embedding 配置
 * @throws 如果必需的配置项缺失
 */
export function getEmbeddingConfig(): EmbeddingConfig {
  const apiKey = process.env.EMBEDDINGS_API_KEY;
  const baseUrl = process.env.EMBEDDINGS_BASE_URL;
  const model = process.env.EMBEDDINGS_MODEL;
  const batchSize = parseInt(process.env.EMBEDDINGS_BATCH_SIZE || '10', 10);
  const maxConcurrency = parseInt(process.env.EMBEDDINGS_MAX_CONCURRENCY || '10', 10);
  const networkRetries = parseInt(process.env.EMBEDDINGS_NETWORK_RETRIES || '5', 10);
  const retryBaseDelayMs = parseInt(process.env.EMBEDDINGS_RETRY_BASE_DELAY_MS || '1000', 10);
  const retryIntervalIncrementMs = parseInt(
    process.env.EMBEDDINGS_RETRY_INTERVAL_INCREMENT_MS || '1000',
    10,
  );
  const requestTimeoutMs = parseInt(process.env.EMBEDDINGS_REQUEST_TIMEOUT_MS || '60000', 10);
  const windowSize = parseInt(process.env.EMBEDDINGS_WINDOW_SIZE || '50', 10);

  if (!apiKey) {
    throw new Error('EMBEDDINGS_API_KEY 环境变量未设置');
  }
  if (!baseUrl) {
    throw new Error('EMBEDDINGS_BASE_URL 环境变量未设置');
  }
  if (!model) {
    throw new Error('EMBEDDINGS_MODEL 环境变量未设置');
  }

  const dimensions = parseInt(process.env.EMBEDDINGS_DIMENSIONS || '1024', 10);
  const maxInputTokens = parseInt(process.env.EMBEDDINGS_MAX_INPUT_TOKENS || '8192', 10);
  const chunkingConfig = getChunkingConfig();

  return {
    apiKey,
    baseUrl,
    model,
    batchSize: Number.isNaN(batchSize) || batchSize < 1 ? 10 : batchSize,
    maxConcurrency: Number.isNaN(maxConcurrency) || maxConcurrency < 1 ? 4 : maxConcurrency,
    networkRetries: Number.isNaN(networkRetries) || networkRetries < 0 ? 5 : networkRetries,
    retryBaseDelayMs:
      Number.isNaN(retryBaseDelayMs) || retryBaseDelayMs < 0 ? 1000 : retryBaseDelayMs,
    retryIntervalIncrementMs:
      Number.isNaN(retryIntervalIncrementMs) || retryIntervalIncrementMs < 0
        ? 1000
        : retryIntervalIncrementMs,
    requestTimeoutMs:
      Number.isNaN(requestTimeoutMs) || requestTimeoutMs < 0 ? 60000 : requestTimeoutMs,
    windowSize: Number.isNaN(windowSize) || windowSize < 1 ? 50 : windowSize,
    dimensions: Number.isNaN(dimensions) ? 1024 : dimensions,
    maxInputTokens: Number.isNaN(maxInputTokens) ? 8192 : maxInputTokens,
    ...chunkingConfig,
  };
}

export function getChunkingConfig(): ChunkingConfig {
  const chunkMaxSize = parseInt(process.env.CW_CHUNK_MAX_SIZE || '1000', 10);
  const chunkMinSize = parseInt(process.env.CW_CHUNK_MIN_SIZE || '50', 10);
  const chunkOverlap = parseInt(process.env.CW_CHUNK_OVERLAP || '20', 10);

  return {
    chunkMaxSize: Number.isNaN(chunkMaxSize) || chunkMaxSize < 1 ? 1000 : chunkMaxSize,
    chunkMinSize: Number.isNaN(chunkMinSize) || chunkMinSize < 1 ? 50 : chunkMinSize,
    chunkOverlap: Number.isNaN(chunkOverlap) || chunkOverlap < 0 ? 20 : chunkOverlap,
  };
}

/**
 * 获取 Reranker 配置
 * @throws 如果必需的配置项缺失
 */
export function getRerankerConfig(): RerankerConfig {
  const apiKey = process.env.RERANK_API_KEY;
  const baseUrl = process.env.RERANK_BASE_URL;
  const model = process.env.RERANK_MODEL;
  const topN = parseInt(process.env.RERANK_TOP_N || '10', 10);

  if (!apiKey) {
    throw new Error('RERANK_API_KEY 环境变量未设置');
  }
  if (!baseUrl) {
    throw new Error('RERANK_BASE_URL 环境变量未设置');
  }
  if (!model) {
    throw new Error('RERANK_MODEL 环境变量未设置');
  }

  return {
    apiKey,
    baseUrl,
    model,
    topN: Number.isNaN(topN) ? 10 : topN,
  };
}

// 排除模式配置

/**
 * 默认排除列表
 *
 * 策略：
 * 1. 绝对屏蔽高 Token 消耗且低语义价值的文件 (Lock files, Maps, Assets)
 * 2. 绝对屏蔽构建产物和依赖 (Dist, node_modules)
 * 3. 智能保留测试逻辑，但剔除测试数据
 */
const DEFAULT_EXCLUDE_PATTERNS = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.idea',
  '.vscode',
  '.vs',
  '.venv',
  'venv',
];

/**
 * 获取合并后的排除模式列表
 * @returns 排除模式数组
 */
export function getExcludePatterns(): string[] {
  return [...DEFAULT_EXCLUDE_PATTERNS];
}

export { isDev };
