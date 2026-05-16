import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processFiles } from '../../src/scanner/processor.js';

const tempDirs: string[] = [];
let previousHome: string | undefined;

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createSymlink(target: string, linkPath: string): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath);
    return true;
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      return false;
    }
    throw err;
  }
}

beforeEach(async () => {
  vi.resetModules();
  vi.restoreAllMocks();
  previousHome = process.env.HOME;
  process.env.HOME = await createTempDir('cw-home-');
});

afterEach(async () => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }

  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('scanner symlink boundaries', () => {
  it('skips symlinks that resolve outside the repository before reading content', async () => {
    const repoRoot = await createTempDir('cw-symlink-repo-');
    const outsideDir = await createTempDir('cw-symlink-outside-');
    const srcDir = path.join(repoRoot, 'src');
    const outsideSecretPath = path.join(outsideDir, 'secret.ts');
    const linkPath = path.join(srcDir, 'leak.ts');

    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(outsideSecretPath, 'export const secret = "do-not-index";\n', 'utf-8');
    if (!(await createSymlink(outsideSecretPath, linkPath))) {
      return;
    }

    const results = await processFiles(repoRoot, [linkPath], new Map());

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      relPath: 'src/leak.ts',
      status: 'skipped',
      skipReason: 'path_escape',
      content: null,
      hash: '',
    });
    expect(JSON.stringify(results)).not.toContain('do-not-index');
  });

  it('allows symlinks that resolve inside the repository root', async () => {
    const repoRoot = await createTempDir('cw-symlink-repo-');
    const srcDir = path.join(repoRoot, 'src');
    const realPath = path.join(srcDir, 'real.ts');
    const linkPath = path.join(srcDir, 'alias.ts');

    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(realPath, 'export const visible = true;\n', 'utf-8');
    if (!(await createSymlink(realPath, linkPath))) {
      return;
    }

    const results = await processFiles(repoRoot, [linkPath], new Map());

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('added');
    expect(results[0]?.content).toContain('visible');
    expect(results[0]?.relPath).toBe('src/alias.ts');
  });
});
