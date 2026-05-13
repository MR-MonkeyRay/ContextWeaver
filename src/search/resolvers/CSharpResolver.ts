/**
 * C# 解析策略 (命名空间→路径映射 + 后缀匹配)
 */

import { commonPrefixLength, type ImportResolver, matchesRootRelativePath } from './types.js';

export class CSharpResolver implements ImportResolver {
  supports(filePath: string): boolean {
    return filePath.endsWith('.cs') || filePath.endsWith('.csx');
  }

  extract(content: string): string[] {
    const imports: string[] = [];

    // 匹配 global using、using static、using Alias = Target、global:: 前缀和 @ 标识符。
    const pattern =
      /^\s*(?:global\s+)?using\s+(?:static\s+)?(?:(?:@?\w+)\s*=\s*)?((?:global::)?@?\w+(?:(?:\.|::)@?\w+)*);/gm;
    for (const match of content.matchAll(pattern)) {
      imports.push(this.normalizeImport(match[1]));
    }
    return imports;
  }

  resolve(importStr: string, currentFile: string, allFiles: Set<string>): string | null {
    const normalizedImport = this.normalizeImport(importStr);
    if (!normalizedImport) return null;

    // 将命名空间转换为路径
    const namespacePath = normalizedImport.replace(/::/g, '.').replace(/\./g, '/');
    const targetPaths = [`${namespacePath}.cs`, `${namespacePath}.csx`];

    const candidates: string[] = [];
    for (const filePath of allFiles) {
      if (targetPaths.some((targetPath) => matchesRootRelativePath(filePath, targetPath))) {
        candidates.push(filePath);
      }
    }

    // 回退策略：尝试匹配最后一个类型名
    // 例如 System.Collections.Generic.List -> 找 List.cs
    if (candidates.length === 0) {
      const parts = normalizedImport.replace(/::/g, '.').split('.');
      const typeName = parts[parts.length - 1];
      const typePaths = [`${typeName}.cs`, `${typeName}.csx`];

      for (const filePath of allFiles) {
        if (typePaths.some((targetPath) => matchesRootRelativePath(filePath, targetPath))) {
          candidates.push(filePath);
        }
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    if (candidates.length === 1) {
      return candidates[0];
    }

    // 歧义消解：优先选择与当前文件路径前缀重叠最多的
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

  private normalizeImport(importStr: string): string {
    return importStr
      .replace(/^global::/, '')
      .replace(/@(?=\w)/g, '')
      .trim();
  }
}
