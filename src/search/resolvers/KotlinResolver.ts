/**
 * Kotlin 解析策略 (包路径后缀匹配)
 */

import { containsRootRelativeDir, type ImportResolver, matchesRootRelativePath } from './types.js';

const KOTLIN_EXTENSIONS = new Set(['.kt', '.kts']);

export class KotlinResolver implements ImportResolver {
  supports(filePath: string): boolean {
    const ext = filePath.slice(filePath.lastIndexOf('.'));
    return KOTLIN_EXTENSIONS.has(ext);
  }

  extract(content: string): string[] {
    const imports: string[] = [];

    // 匹配 import a.b.C、import a.b.*、import a.b.C as Alias。
    const pattern = /^\s*import\s+([\w.]+(?:\.\*|\.\w+))(?:\s+as\s+\w+)?\s*$/gm;
    for (const match of content.matchAll(pattern)) {
      imports.push(match[1]);
    }

    return imports;
  }

  resolve(importStr: string, _currentFile: string, allFiles: Set<string>): string | null {
    if (importStr.endsWith('.*')) {
      const pkgPath = importStr.slice(0, -2).replace(/\./g, '/');

      for (const filePath of allFiles) {
        if (this.isKotlinFile(filePath) && containsRootRelativeDir(filePath, pkgPath)) {
          return filePath;
        }
      }

      return null;
    }

    const classPath = importStr.replace(/\./g, '/');
    for (const ext of KOTLIN_EXTENSIONS) {
      const targetPath = `${classPath}${ext}`;
      for (const filePath of allFiles) {
        if (matchesRootRelativePath(filePath, targetPath)) {
          return filePath;
        }
      }
    }

    return null;
  }

  private isKotlinFile(filePath: string): boolean {
    return [...KOTLIN_EXTENSIONS].some((ext) => filePath.endsWith(ext));
  }
}
