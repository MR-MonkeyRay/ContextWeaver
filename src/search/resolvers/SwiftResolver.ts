/**
 * Swift 解析策略 (import/@testable import 解析)
 */

import {
  commonPrefixLength,
  containsRootRelativeDir,
  type ImportResolver,
  matchesRootRelativePath,
} from './types.js';

const SWIFT_EXTENSION = '.swift';

export class SwiftResolver implements ImportResolver {
  supports(filePath: string): boolean {
    return filePath.endsWith(SWIFT_EXTENSION);
  }

  extract(content: string): string[] {
    const imports: string[] = [];

    const pattern =
      /^\s*(?:@testable\s+)?import\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func)\s+)?([\w.]+)\s*;?\s*$/gm;
    for (const match of content.matchAll(pattern)) {
      imports.push(match[1]);
    }

    return imports;
  }

  resolve(importStr: string, currentFile: string, allFiles: Set<string>): string | null {
    const swiftFiles = [...allFiles].filter((filePath) => filePath.endsWith(SWIFT_EXTENSION));
    if (swiftFiles.length === 0) {
      return null;
    }

    const exactPath = importStr.replace(/\./g, '/');
    const exactTargetPath = `${exactPath}${SWIFT_EXTENSION}`;
    for (const filePath of swiftFiles) {
      if (matchesRootRelativePath(filePath, exactTargetPath)) {
        return filePath;
      }
    }

    const moduleName = importStr.split('.')[0];
    const moduleFilePath = `${moduleName}${SWIFT_EXTENSION}`;
    const candidates = swiftFiles.filter(
      (filePath) =>
        matchesRootRelativePath(filePath, moduleFilePath) ||
        containsRootRelativeDir(filePath, moduleName),
    );

    if (candidates.length === 0) {
      return null;
    }
    if (candidates.length === 1) {
      return candidates[0];
    }

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
}
