/**
 * PHP 解析策略 (use 语句解析 + 命名空间路径后缀匹配)
 */

import { commonPrefixLength, type ImportResolver, matchesRootRelativePath } from './types.js';

export class PhpResolver implements ImportResolver {
  supports(filePath: string): boolean {
    return filePath.endsWith('.php');
  }

  extract(content: string): string[] {
    const imports: string[] = [];

    // 匹配 use Foo\Bar、use function Foo\bar、use Foo\{A,B as C}。
    const usePattern = /^\s*use\s+(?:(?:function|const)\s+)?([^;]+);/gm;
    for (const match of content.matchAll(usePattern)) {
      const useBody = match[1]?.trim();
      if (!useBody) continue;

      for (const importPath of this.expandUseBody(useBody)) {
        const normalized = importPath.replace(/^\\+/, '').trim();
        if (normalized) {
          imports.push(normalized);
        }
      }
    }

    return imports;
  }

  resolve(importStr: string, currentFile: string, allFiles: Set<string>): string | null {
    const normalized = importStr.replace(/^\\+/, '').replace(/\\/g, '/');
    if (!normalized) return null;

    const candidates = this.collectCandidates(normalized, allFiles);
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

  private expandUseBody(useBody: string): string[] {
    const groupedMatch = useBody.match(/^(.*?)\\\s*\{([^}]+)\}$/);
    if (groupedMatch) {
      const prefix = groupedMatch[1].trim().replace(/\s+/g, '');
      return groupedMatch[2]
        .split(',')
        .map((item) => this.stripAlias(item.trim()).replace(/\s+/g, ''))
        .filter(Boolean)
        .map((member) => `${prefix}\\${member}`);
    }

    return useBody
      .split(',')
      .map((part) => this.stripAlias(part.trim()).replace(/\s+/g, ''))
      .filter(Boolean);
  }

  private stripAlias(importClause: string): string {
    return importClause.split(/\s+as\s+/i)[0].trim();
  }

  private collectCandidates(modulePath: string, allFiles: Set<string>): string[] {
    const candidates: string[] = [];
    const targetPaths = [`${modulePath}.php`, `${modulePath}/index.php`];

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

    const fallbackPaths = [`${name}.php`, `${name}/index.php`];
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
