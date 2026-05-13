/**
 * Ruby 解析策略 (require/autoload 解析 + 路径解析)
 */

import { commonPrefixLength, type ImportResolver, matchesRootRelativePath } from './types.js';

export class RubyResolver implements ImportResolver {
  supports(filePath: string): boolean {
    return filePath.endsWith('.rb');
  }

  extract(content: string): string[] {
    const imports: string[] = [];

    const requirePattern = /^\s*require\s+['"]([^'"]+)['"]/gm;
    for (const match of content.matchAll(requirePattern)) {
      imports.push(`require:${match[1]}`);
    }

    const requireRelativePattern = /^\s*require_relative\s+['"]([^'"]+)['"]/gm;
    for (const match of content.matchAll(requireRelativePattern)) {
      imports.push(`require_relative:${match[1]}`);
    }

    const autoloadPattern = /^\s*autoload\s+:\w+\s*,\s*['"]([^'"]+)['"]/gm;
    for (const match of content.matchAll(autoloadPattern)) {
      imports.push(`autoload:${match[1]}`);
    }

    return imports;
  }

  resolve(importStr: string, currentFile: string, allFiles: Set<string>): string | null {
    if (importStr.startsWith('require_relative:')) {
      return this.resolveRelative(
        importStr.slice('require_relative:'.length),
        currentFile,
        allFiles,
      );
    }

    if (importStr.startsWith('require:')) {
      return this.resolveLogicalPath(importStr.slice('require:'.length), currentFile, allFiles);
    }

    if (importStr.startsWith('autoload:')) {
      return this.resolveLogicalPath(importStr.slice('autoload:'.length), currentFile, allFiles);
    }

    return null;
  }

  private resolveRelative(
    relativePath: string,
    currentFile: string,
    allFiles: Set<string>,
  ): string | null {
    if (!relativePath) return null;

    const currentDir = currentFile.split('/').slice(0, -1);
    const parts = [...currentDir, ...relativePath.split('/')];
    const resolvedParts: string[] = [];

    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (resolvedParts.length === 0) {
          return null;
        }
        resolvedParts.pop();
        continue;
      }
      resolvedParts.push(part);
    }

    return this.pickFirstExisting(resolvedParts.join('/'), allFiles);
  }

  private resolveLogicalPath(
    logicalPath: string,
    currentFile: string,
    allFiles: Set<string>,
  ): string | null {
    const normalized = logicalPath.replace(/^\/+/, '').replace(/\.rb$/, '');
    if (!normalized) return null;

    const candidates = this.collectSuffixCandidates(normalized, allFiles);
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    let bestCandidate = candidates[0];
    let bestPrefixLen = commonPrefixLength(currentFile, bestCandidate);
    for (let i = 1; i < candidates.length; i++) {
      const prefixLen = commonPrefixLength(currentFile, candidates[i]);
      if (prefixLen > bestPrefixLen) {
        bestPrefixLen = prefixLen;
        bestCandidate = candidates[i];
      }
    }

    return bestCandidate;
  }

  private pickFirstExisting(basePath: string, allFiles: Set<string>): string | null {
    if (basePath.endsWith('.rb')) {
      return allFiles.has(basePath) ? basePath : null;
    }

    const candidates = [`${basePath}.rb`, `${basePath}/index.rb`];
    return candidates.find((candidate) => allFiles.has(candidate)) ?? null;
  }

  private collectSuffixCandidates(modulePath: string, allFiles: Set<string>): string[] {
    const candidates: string[] = [];
    const targetPaths = [`${modulePath}.rb`, `${modulePath}/index.rb`];

    for (const filePath of allFiles) {
      for (const targetPath of targetPaths) {
        if (matchesRootRelativePath(filePath, targetPath)) {
          candidates.push(filePath);
          break;
        }
      }
    }

    if (candidates.length > 0) {
      return candidates;
    }

    const name = modulePath.split('/').at(-1);
    if (!name) return candidates;

    const fallbackPaths = [`${name}.rb`, `${name}/index.rb`];
    for (const filePath of allFiles) {
      for (const targetPath of fallbackPaths) {
        if (matchesRootRelativePath(filePath, targetPath)) {
          candidates.push(filePath);
          break;
        }
      }
    }

    return candidates;
  }
}
