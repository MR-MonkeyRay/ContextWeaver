/**
 * Indexer Service - 向量索引编排层
 *
 * 负责协调 chunking → embedding → 写入 LanceDB 的完整流程
 * 核心特性：
 * - 自愈机制：检测 vector_index_hash != hash 的文件进行补索引
 * - 单调版本更新：先插入新版本再删除旧版本，避免缺失窗口
 * - 批量处理：优化 embedding API 调用
 */

import type Database from 'better-sqlite3';
import {
  type EmbeddingClient,
  EmbeddingFatalError,
  getEmbeddingClient,
} from '../api/embedding/index.js';
import type { ProcessedChunk } from '../chunking/types.js';
import { batchUpdateVectorIndexHash, clearVectorIndexHash } from '../db/index.js';
import type { ProcessResult } from '../scanner/processor.js';
import {
  batchDeleteFileChunksFts,
  batchUpsertChunkFts,
  isChunksFtsInitialized,
} from '../search/fts.js';
import { logger } from '../utils/logger.js';
import { type ChunkRecord, getVectorStore, type VectorStore } from '../vectorStore/index.js';

// ===========================================
// 类型定义
// ===========================================

/** 索引统计 */
export interface IndexStats {
  indexed: number;
  deleted: number;
  errors: number;
  skipped: number;
}

/** 索引文件信息 */
interface FileToIndex {
  path: string;
  hash: string;
  chunks: ProcessedChunk[];
}

interface IndexedWindow {
  filesToUpsert: Array<{
    path: string;
    hash: string;
    records: ChunkRecord[];
  }>;
  ftsChunks: Array<{
    chunkId: string;
    filePath: string;
    chunkIndex: number;
    breadcrumb: string;
    content: string;
  }>;
  successFiles: Array<{ path: string; hash: string }>;
}

// ===========================================
// Indexer 类
// ===========================================

export class Indexer {
  private projectId: string;
  private vectorStore: VectorStore | null = null;
  private embeddingClient: EmbeddingClient;
  private vectorDim: number;

  constructor(projectId: string, vectorDim = 1024) {
    this.projectId = projectId;
    this.vectorDim = vectorDim;
    this.embeddingClient = getEmbeddingClient();
  }

  /**
   * 初始化
   */
  async init(): Promise<void> {
    this.vectorStore = await getVectorStore(this.projectId, this.vectorDim);
  }

  /**
   * 处理扫描结果，更新向量索引
   *
   * @param db SQLite 数据库实例
   * @param results 文件处理结果
   * @param onProgress 可选的进度回调 (indexed, total) => void
   */
  async indexFiles(
    db: Database.Database,
    results: ProcessResult[],
    onProgress?: (indexed: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<IndexStats> {
    signal?.throwIfAborted();
    if (!this.vectorStore) {
      await this.init();
    }

    const stats: IndexStats = {
      indexed: 0,
      deleted: 0,
      errors: 0,
      skipped: 0,
    };

    // 分类处理结果
    const toIndex: FileToIndex[] = [];
    const toDelete: string[] = [];
    const noChunkSettled: Array<{ path: string; hash: string }> = [];

    for (const result of results) {
      switch (result.status) {
        case 'added':
        case 'modified':
          if (result.chunks.length > 0) {
            toIndex.push({
              path: result.relPath,
              hash: result.hash,
              chunks: result.chunks,
            });
          } else {
            // chunks 为空（解析失败或空文件）
            // 仅 modified 文件可能有旧向量记录需要清除，added 文件从未存在过向量记录
            if (result.status === 'modified') {
              toDelete.push(result.relPath);
            }
            noChunkSettled.push({
              path: result.relPath,
              hash: result.hash,
            });
            stats.skipped++;
          }
          break;

        case 'deleted':
          toDelete.push(result.relPath);
          break;

        case 'unchanged':
          stats.skipped++;
          break;

        case 'skipped':
        case 'error':
          stats.skipped++;
          break;
      }
    }

    // 处理删除
    if (toDelete.length > 0) {
      await this.deleteFiles(db, toDelete);
      signal?.throwIfAborted();
      stats.deleted = toDelete.length;
    }

    // chunks 为空的文件视为已收敛：标记 vector_index_hash=hash
    // 避免这些文件在下一轮被持续判定为“需要自愈”
    if (noChunkSettled.length > 0) {
      batchUpdateVectorIndexHash(db, noChunkSettled);
      logger.debug({ count: noChunkSettled.length }, '无可索引 chunk，标记向量索引状态为已收敛');
    }

    // 批量处理需要索引的文件
    if (toIndex.length > 0) {
      const indexResult = await this.batchIndex(db, toIndex, onProgress, signal);
      stats.indexed = indexResult.success;
      stats.errors = indexResult.errors;
    }

    logger.info(
      {
        indexed: stats.indexed,
        vectorRecordsDeleted: stats.deleted,
        errors: stats.errors,
        skipped: stats.skipped,
      },
      '向量索引完成',
    );

    return stats;
  }

  /**
   * 批量索引文件（性能优化版）
   *
   * 优化策略：
   * 1. Embedding 已批量化（原有）
   * 2. LanceDB 写入批量化：N 次 upsertFile → 1 次 batchUpsertFiles
   * 3. FTS 写入批量化：N 次删除+插入 → 1 次批量删除 + 1 次批量插入
   * 4. 日志汇总化：逐文件日志 → 汇总日志
   */
  private async batchIndex(
    db: Database.Database,
    files: FileToIndex[],
    onProgress?: (indexed: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<{ success: number; errors: number }> {
    if (files.length === 0) {
      return { success: 0, errors: 0 };
    }

    const totalItems = files.reduce((sum, file) => sum + file.chunks.length, 0);

    if (totalItems === 0) {
      return { success: 0, errors: 0 };
    }

    const { batchSize, windowSize } = this.embeddingClient.getConfig();
    const windows = this.buildIndexWindows(files, windowSize);
    logger.info(
      { count: totalItems, files: files.length, batchSize, windowSize, windows: windows.length },
      '开始窗口化批量 Embedding',
    );

    let completedItems = 0;
    let success = 0;
    let errors = 0;
    let firstEmbeddingError: unknown = null;

    for (const windowFiles of windows) {
      signal?.throwIfAborted();
      const windowItems = windowFiles.reduce((sum, file) => sum + file.chunks.length, 0);
      let windowCompleted = 0;

      try {
        const indexedWindow = await this.indexWindow(
          windowFiles,
          batchSize,
          (completed, total) => {
            signal?.throwIfAborted();
            const mappedCompleted = Math.min(
              windowItems,
              Math.floor((completed / total) * windowItems),
            );
            windowCompleted = Math.max(windowCompleted, mappedCompleted);
            onProgress?.(completedItems + windowCompleted, totalItems);
          },
          signal,
        );

        signal?.throwIfAborted();
        await this.persistWindow(db, indexedWindow);
        signal?.throwIfAborted();
        completedItems += windowItems;
        onProgress?.(completedItems, totalItems);
        success += indexedWindow.successFiles.length;
        logger.info(
          {
            files: indexedWindow.successFiles.length,
            chunks: indexedWindow.ftsChunks.length,
            completedItems: completedItems,
            totalItems,
          },
          '索引窗口完成',
        );
      } catch (err) {
        if (signal?.aborted) {
          clearVectorIndexHash(
            db,
            windowFiles.map((f) => f.path),
          );
          signal.throwIfAborted();
        }
        const error = err as { message?: string; stack?: string };
        logger.error(
          {
            files: windowFiles.length,
            chunks: windowItems,
            error: error.message,
            stack: error.stack,
          },
          '索引窗口失败',
        );
        clearVectorIndexHash(
          db,
          windowFiles.map((f) => f.path),
        );
        errors += windowFiles.length;
        firstEmbeddingError ??= err;
        completedItems += windowItems;
        onProgress?.(completedItems, totalItems);

        if (!this.canContinueAfterWindowFailure(err)) {
          break;
        }
      }
    }

    if (firstEmbeddingError) {
      if (success > 0) {
        logger.warn(
          { success, errors },
          '部分索引窗口已成功写入，失败窗口将在下次索引时通过自愈补索引',
        );
      }
      const err = firstEmbeddingError;
      if (err instanceof EmbeddingFatalError) {
        const upstreamMessage = err.diagnostics.upstreamMessage || err.message || '未知错误';
        throw new EmbeddingFatalError(`向量嵌入阶段失败: ${upstreamMessage}`, {
          cause: err,
          diagnostics: err.diagnostics,
        });
      }
      const error = err as { message?: string };
      throw new EmbeddingFatalError(`向量嵌入阶段失败: ${error.message || '未知错误'}`, {
        cause: err,
      });
    }

    logger.info({ success, errors }, '批量索引完成');
    return { success, errors };
  }

  private canContinueAfterWindowFailure(err: unknown): boolean {
    if (!(err instanceof EmbeddingFatalError)) {
      return false;
    }

    if (err.diagnostics.category === 'network' || err.diagnostics.category === 'timeout') {
      return true;
    }

    return typeof err.diagnostics.httpStatus === 'number' && err.diagnostics.httpStatus >= 500;
  }

  private buildIndexWindows(files: FileToIndex[], windowSize: number): FileToIndex[][] {
    const windows: FileToIndex[][] = [];
    let currentWindow: FileToIndex[] = [];
    let currentItemCount = 0;

    for (const file of files) {
      const itemCount = file.chunks.length;

      if (currentWindow.length > 0 && currentItemCount + itemCount > windowSize) {
        windows.push(currentWindow);
        currentWindow = [];
        currentItemCount = 0;
      }

      currentWindow.push(file);
      currentItemCount += itemCount;

      if (currentItemCount >= windowSize) {
        windows.push(currentWindow);
        currentWindow = [];
        currentItemCount = 0;
      }
    }

    if (currentWindow.length > 0) {
      windows.push(currentWindow);
    }

    return windows;
  }

  private async indexWindow(
    files: FileToIndex[],
    batchSize: number,
    onProgress?: (completed: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<IndexedWindow> {
    const allTexts: string[] = [];
    const globalIndexByFileChunk: number[][] = [];

    for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
      const file = files[fileIdx];
      globalIndexByFileChunk[fileIdx] = [];
      for (let chunkIdx = 0; chunkIdx < file.chunks.length; chunkIdx++) {
        const globalIdx = allTexts.length;
        allTexts.push(file.chunks[chunkIdx].vectorText);
        globalIndexByFileChunk[fileIdx][chunkIdx] = globalIdx;
      }
    }

    const results = await this.embeddingClient.embedBatch(allTexts, batchSize, onProgress, signal);
    signal?.throwIfAborted();
    const embeddings = results.map((r) => r.embedding);

    const filesToUpsert: IndexedWindow['filesToUpsert'] = [];
    const ftsChunks: IndexedWindow['ftsChunks'] = [];
    const successFiles: IndexedWindow['successFiles'] = [];

    for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
      const file = files[fileIdx];
      const records: ChunkRecord[] = [];

      for (let chunkIdx = 0; chunkIdx < file.chunks.length; chunkIdx++) {
        const chunk = file.chunks[chunkIdx];
        const globalIdx = globalIndexByFileChunk[fileIdx][chunkIdx];

        if (globalIdx === undefined) {
          throw new Error(`找不到 chunk 的 embedding: ${file.path}#${chunkIdx}`);
        }

        const record: ChunkRecord = {
          chunk_id: `${file.path}#${file.hash}#${chunkIdx}`,
          file_path: file.path,
          file_hash: file.hash,
          chunk_index: chunkIdx,
          vector: embeddings[globalIdx],
          display_code: chunk.displayCode,
          vector_text: chunk.vectorText,
          language: chunk.metadata.language,
          breadcrumb: chunk.metadata.contextPath.join(' > '),
          start_index: chunk.metadata.startIndex,
          end_index: chunk.metadata.endIndex,
          raw_start: chunk.metadata.rawSpan.start,
          raw_end: chunk.metadata.rawSpan.end,
          vec_start: chunk.metadata.vectorSpan.start,
          vec_end: chunk.metadata.vectorSpan.end,
        };

        records.push(record);
        ftsChunks.push({
          chunkId: record.chunk_id,
          filePath: record.file_path,
          chunkIndex: record.chunk_index,
          breadcrumb: record.breadcrumb,
          content: `${record.breadcrumb}\n${record.display_code}`,
        });
      }

      filesToUpsert.push({ path: file.path, hash: file.hash, records });
      successFiles.push({ path: file.path, hash: file.hash });
    }

    return {
      filesToUpsert,
      ftsChunks,
      successFiles,
    };
  }

  private async persistWindow(db: Database.Database, indexedWindow: IndexedWindow): Promise<void> {
    if (indexedWindow.filesToUpsert.length > 0) {
      try {
        await this.vectorStore?.batchUpsertFiles(indexedWindow.filesToUpsert);
        logger.info(
          { files: indexedWindow.filesToUpsert.length, chunks: indexedWindow.ftsChunks.length },
          'LanceDB 窗口写入完成',
        );
      } catch (err) {
        const error = err as { message?: string; stack?: string };
        logger.error({ error: error.message, stack: error.stack }, 'LanceDB 窗口写入失败');
        clearVectorIndexHash(
          db,
          indexedWindow.filesToUpsert.map((f) => f.path),
        );
        throw err;
      }
    }

    if (isChunksFtsInitialized(db) && indexedWindow.ftsChunks.length > 0) {
      try {
        const pathsToDelete = indexedWindow.filesToUpsert.map((f) => f.path);
        batchDeleteFileChunksFts(db, pathsToDelete);
        batchUpsertChunkFts(db, indexedWindow.ftsChunks);
      } catch (err) {
        const error = err as { message?: string };
        logger.warn({ error: error.message }, 'FTS 窗口更新失败（向量索引已成功）');
      }
    }

    if (indexedWindow.successFiles.length > 0) {
      batchUpdateVectorIndexHash(db, indexedWindow.successFiles);
    }
  }

  /**
   * 删除文件的向量和 FTS 索引
   */
  private async deleteFiles(db: Database.Database, paths: string[]): Promise<void> {
    if (!this.vectorStore) return;

    // 删除向量索引
    await this.vectorStore.deleteFiles(paths);

    // 删除 chunk FTS 索引
    if (isChunksFtsInitialized(db)) {
      batchDeleteFileChunksFts(db, paths);
    }

    logger.debug({ count: paths.length }, '删除文件索引');
  }

  /**
   * 向量搜索
   */
  async search(queryVector: number[], limit = 10, filter?: string) {
    if (!this.vectorStore) {
      await this.init();
    }
    return this.vectorStore?.search(queryVector, limit, filter);
  }

  /**
   * 文本搜索（先 embedding 再向量搜索）
   */
  async textSearch(query: string, limit = 10, filter?: string, signal?: AbortSignal) {
    const queryVector = await this.embeddingClient.embed(query, signal);
    signal?.throwIfAborted();
    const results = await this.search(queryVector, limit, filter);
    signal?.throwIfAborted();
    return results;
  }

  /**
   * 清空索引
   */
  async clear(): Promise<void> {
    if (!this.vectorStore) {
      await this.init();
    }
    await this.vectorStore?.clear();
  }

  /**
   * 获取索引统计
   */
  async getStats(): Promise<{ totalChunks: number }> {
    if (!this.vectorStore) {
      await this.init();
    }
    const count = (await this.vectorStore?.count()) ?? 0;
    return { totalChunks: count };
  }
}

// ===========================================
// 工厂函数
// ===========================================

const indexers = new Map<string, Indexer>();

/**
 * 获取或创建 Indexer 实例
 */
export async function getIndexer(projectId: string, vectorDim = 1024): Promise<Indexer> {
  let indexer = indexers.get(projectId);
  if (!indexer) {
    indexer = new Indexer(projectId, vectorDim);
    await indexer.init();
    indexers.set(projectId, indexer);
  }
  return indexer;
}

/**
 * 关闭所有 Indexer
 */
export function closeAllIndexers(): void {
  indexers.clear();
}
