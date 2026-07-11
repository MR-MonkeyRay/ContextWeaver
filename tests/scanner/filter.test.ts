import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crawl } from '../../src/scanner/crawler.js';
import { initFilter, isAllowedFile, isFiltered, isIncluded } from '../../src/scanner/filter.js';

const tempDirs: string[] = [];
let previousHome: string | undefined;
let previousXdgConfigHome: string | undefined;

async function createRepo(options?: {
  cwconfig?: Record<string, unknown>;
  gitignore?: string;
  files?: Record<string, string>;
}): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-filter-'));
  tempDirs.push(repoRoot);

  const files = options?.files ?? {
    'src/app.ts': 'export const app = true;\n',
    'src/generated/schema.ts': 'export const schema = true;\n',
    'src/nested/deep/file.ts': 'export const deep = true;\n',
    'packages/core/src/index.ts': 'export const core = true;\n',
    'docs/readme.md': '# docs\n',
    'dist/index.ts': 'export const dist = true;\n',
    'examples/cwconfig.json': '{"demo":true}\n',
    'logs/debug.ts': 'export const log = true;\n',
  };

  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      const fullPath = path.join(repoRoot, relativePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, 'utf-8');
    }),
  );

  if (options?.gitignore !== undefined) {
    await fs.writeFile(path.join(repoRoot, '.gitignore'), options.gitignore, 'utf-8');
  }

  if (options?.cwconfig !== undefined) {
    await fs.writeFile(
      path.join(repoRoot, 'cwconfig.json'),
      JSON.stringify(options.cwconfig, null, 2),
      'utf-8',
    );
  }

  return repoRoot;
}

async function useIsolatedGitConfig(): Promise<{ home: string; xdgConfigHome: string }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-filter-home-'));
  const xdgConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-filter-xdg-'));
  tempDirs.push(home, xdgConfigHome);

  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = xdgConfigHome;

  return { home, xdgConfigHome };
}

beforeEach(async () => {
  previousHome = process.env.HOME;
  previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  await useIsolatedGitConfig();
});

afterEach(async () => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }

  if (previousXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
  }

  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('scanner filter', () => {
  it('defaults to including repo files when cwconfig.json is missing', async () => {
    const repoRoot = await createRepo();

    await initFilter(repoRoot);

    expect(isIncluded('src/app.ts')).toBe(true);
    expect(isFiltered('src/app.ts')).toBe(false);
  });

  it('treats patterns as repo-relative normalized paths', async () => {
    const repoRoot = await createRepo({
      cwconfig: {
        indexing: { includePatterns: ['packages/*/src/**'] },
      },
    });

    await initFilter(repoRoot);

    expect(isIncluded('packages/core/src/index.ts')).toBe(true);
    expect(isIncluded('src/app.ts')).toBe(false);
  });

  it('matches directory include patterns recursively', async () => {
    const repoRoot = await createRepo({
      cwconfig: {
        indexing: { includePatterns: ['src/'] },
      },
    });

    await initFilter(repoRoot);

    expect(isIncluded('src/nested/deep/file.ts')).toBe(true);
  });

  it('subtracts ignore patterns from included paths', async () => {
    const repoRoot = await createRepo({
      cwconfig: {
        indexing: {
          includePatterns: ['src/**'],
          ignorePatterns: ['src/generated/**'],
        },
      },
    });

    await initFilter(repoRoot);

    expect(isIncluded('src/generated/schema.ts')).toBe(true);
    expect(isFiltered('src/generated/schema.ts')).toBe(true);
  });

  it('treats dist and generated as project-config responsibilities, not hard excludes', async () => {
    const repoRoot = await createRepo({
      cwconfig: {
        indexing: { includePatterns: ['dist/**', 'generated/**'] },
      },
      files: {
        'dist/index.js': 'export const built = true;\n',
        'generated/schema.json': '{"ok":true}\n',
      },
    });

    await initFilter(repoRoot);

    expect(isFiltered('dist/index.js')).toBe(false);
    expect(isFiltered('generated/schema.json')).toBe(false);
  });

  it('allows retrievable source, shell, and YAML files while rejecting unknown types', async () => {
    expect(isAllowedFile('src/app.ts')).toBe(true);
    expect(isAllowedFile('scripts/dev.sh')).toBe(true);
    expect(isAllowedFile('scripts/profile.bash')).toBe(true);
    expect(isAllowedFile('config/site.yaml')).toBe(true);
    expect(isAllowedFile('playbooks/deploy.yml')).toBe(true);
    expect(isAllowedFile('assets/logo.png')).toBe(false);
  });

  it('does not allow includePatterns to re-include gitignored files', async () => {
    const repoRoot = await createRepo({
      cwconfig: {
        indexing: { includePatterns: ['logs/**'] },
      },
      gitignore: 'logs/\n',
    });

    await initFilter(repoRoot);

    expect(isIncluded('logs/debug.ts')).toBe(true);
    expect(isFiltered('logs/debug.ts')).toBe(true);
  });

  it('applies core.excludesFile from git config without overriding project ignores', async () => {
    const repoRoot = await createRepo({
      cwconfig: {
        indexing: {
          includePatterns: ['logs/**', 'src/generated/**'],
          ignorePatterns: ['src/generated/**'],
        },
      },
    });
    const globalIgnorePath = path.join(process.env.HOME ?? '', 'global-ignore');
    await fs.mkdir(path.join(repoRoot, '.git'), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, '.git', 'config'),
      '[core]\n  excludesFile = ~/global-ignore\n',
      'utf-8',
    );
    await fs.writeFile(globalIgnorePath, 'logs/\n!src/generated/schema.ts\n', 'utf-8');

    await initFilter(repoRoot);

    expect(isIncluded('logs/debug.ts')).toBe(true);
    expect(isFiltered('logs/debug.ts')).toBe(true);
    expect(isFiltered('src/generated/schema.ts')).toBe(true);
  });

  it('uses the last duplicate core.excludesFile from one config file', async () => {
    const repoRoot = await createRepo();
    await fs.mkdir(path.join(repoRoot, '.git'), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, '.git', 'config'),
      '[core]\n  excludesFile = first-ignore\n  excludesFile = second-ignore\n',
      'utf-8',
    );
    await fs.writeFile(path.join(repoRoot, 'first-ignore'), 'logs/\n', 'utf-8');
    await fs.writeFile(path.join(repoRoot, 'second-ignore'), 'docs/\n', 'utf-8');

    await initFilter(repoRoot);

    expect(isFiltered('logs/debug.ts')).toBe(false);
    expect(isFiltered('docs/readme.md')).toBe(true);
  });

  it('strips unquoted inline comments from core.excludesFile values', async () => {
    const repoRoot = await createRepo();
    await fs.mkdir(path.join(repoRoot, '.git'), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, '.git', 'config'),
      '[core]\n  excludesFile = global-ignore # comment ; also comment\n',
      'utf-8',
    );
    await fs.writeFile(path.join(repoRoot, 'global-ignore'), 'logs/\n', 'utf-8');
    await fs.writeFile(
      path.join(repoRoot, 'global-ignore # comment ; also comment'),
      'docs/\n',
      'utf-8',
    );

    await initFilter(repoRoot);

    expect(isFiltered('logs/debug.ts')).toBe(true);
    expect(isFiltered('docs/readme.md')).toBe(false);
  });

  it('preserves inline comment characters inside quoted core.excludesFile values', async () => {
    const repoRoot = await createRepo();
    await fs.mkdir(path.join(repoRoot, '.git'), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, '.git', 'config'),
      '[core]\n  excludesFile = "ignore # still path"\n',
      'utf-8',
    );
    await fs.writeFile(path.join(repoRoot, 'ignore # still path'), 'logs/\n', 'utf-8');

    await initFilter(repoRoot);

    expect(isFiltered('logs/debug.ts')).toBe(true);
  });

  it('unescapes quoted core.excludesFile values', async () => {
    const repoRoot = await createRepo();
    await fs.mkdir(path.join(repoRoot, '.git'), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, '.git', 'config'),
      '[core]\n  excludesFile = "ignore \\"quoted\\" \\\\ slash"\n',
      'utf-8',
    );
    await fs.writeFile(path.join(repoRoot, 'ignore "quoted" \\ slash'), 'logs/\n', 'utf-8');

    await initFilter(repoRoot);

    expect(isFiltered('logs/debug.ts')).toBe(true);
  });

  it('ignores core subsection excludesFile entries', async () => {
    const repoRoot = await createRepo();
    const xdgIgnorePath = path.join(process.env.XDG_CONFIG_HOME ?? '', 'git', 'ignore');
    await fs.mkdir(path.join(repoRoot, '.git'), { recursive: true });
    await fs.mkdir(path.dirname(xdgIgnorePath), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, '.git', 'config'),
      '[core "subsection"]\n  excludesFile = subsection-ignore\n',
      'utf-8',
    );
    await fs.writeFile(path.join(repoRoot, 'subsection-ignore'), 'logs/\n', 'utf-8');
    await fs.writeFile(xdgIgnorePath, 'docs/\n', 'utf-8');

    await initFilter(repoRoot);

    expect(isFiltered('logs/debug.ts')).toBe(false);
    expect(isFiltered('docs/readme.md')).toBe(true);
  });

  it('resolves relative core.excludesFile from the scanned repo root', async () => {
    const repoRoot = await createRepo();
    await fs.mkdir(path.join(repoRoot, '.git'), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, '.git', 'config'),
      '[core]\n  excludesFile = relative-ignore\n',
      'utf-8',
    );
    await fs.writeFile(path.join(repoRoot, 'relative-ignore'), 'logs/\n', 'utf-8');

    await initFilter(repoRoot);

    expect(isFiltered('logs/debug.ts')).toBe(true);
  });

  it('falls back to XDG git ignore when core.excludesFile is not configured', async () => {
    const repoRoot = await createRepo();
    const xdgIgnorePath = path.join(process.env.XDG_CONFIG_HOME ?? '', 'git', 'ignore');
    await fs.mkdir(path.dirname(xdgIgnorePath), { recursive: true });
    await fs.writeFile(xdgIgnorePath, 'logs/\n', 'utf-8');

    await initFilter(repoRoot);

    expect(isFiltered('logs/debug.ts')).toBe(true);
  });

  it('treats an empty includePatterns array as an empty scope', async () => {
    const repoRoot = await createRepo({
      cwconfig: {
        indexing: { includePatterns: [] },
      },
    });

    await initFilter(repoRoot);

    expect(isIncluded('src/app.ts')).toBe(false);
  });

  it('updates include state when cwconfig.json changes', async () => {
    const repoRoot = await createRepo({
      cwconfig: {
        indexing: { includePatterns: ['src/**'] },
      },
    });

    await initFilter(repoRoot);
    expect(isIncluded('src/app.ts')).toBe(true);
    expect(isIncluded('packages/core/src/index.ts')).toBe(false);

    await fs.writeFile(
      path.join(repoRoot, 'cwconfig.json'),
      JSON.stringify({ indexing: { includePatterns: ['packages/*/src/**'] } }, null, 2),
      'utf-8',
    );

    await initFilter(repoRoot);

    expect(isIncluded('src/app.ts')).toBe(false);
    expect(isIncluded('packages/core/src/index.ts')).toBe(true);
  });

  it('updates filtering when global git ignore changes', async () => {
    const repoRoot = await createRepo();
    const xdgIgnorePath = path.join(process.env.XDG_CONFIG_HOME ?? '', 'git', 'ignore');
    await fs.mkdir(path.dirname(xdgIgnorePath), { recursive: true });
    await fs.writeFile(xdgIgnorePath, 'logs/\n', 'utf-8');

    await initFilter(repoRoot);
    expect(isFiltered('logs/debug.ts')).toBe(true);
    expect(isFiltered('docs/readme.md')).toBe(false);

    await fs.writeFile(xdgIgnorePath, 'docs/\n', 'utf-8');

    await initFilter(repoRoot);

    expect(isFiltered('logs/debug.ts')).toBe(false);
    expect(isFiltered('docs/readme.md')).toBe(true);
  });

  it('never includes cwconfig.json itself in index candidates', async () => {
    const repoRoot = await createRepo({
      cwconfig: {
        indexing: { includePatterns: ['cwconfig.json', 'src/**'] },
      },
    });

    await initFilter(repoRoot);

    expect(isIncluded('cwconfig.json')).toBe(true);
    expect(isFiltered('cwconfig.json')).toBe(true);
  });

  it('does not treat nested cwconfig.json files as the project config file', async () => {
    const repoRoot = await createRepo({
      cwconfig: {
        indexing: { includePatterns: ['examples/**'] },
      },
    });

    await initFilter(repoRoot);

    expect(isIncluded('examples/cwconfig.json')).toBe(true);
    expect(isFiltered('examples/cwconfig.json')).toBe(false);
  });

  it('does not let gitignore negation override project ignores or root cwconfig exclusion', async () => {
    const repoRoot = await createRepo({
      cwconfig: {
        indexing: {
          includePatterns: ['dist/**', 'src/generated/**', 'cwconfig.json'],
          ignorePatterns: ['src/generated/**'],
        },
      },
      gitignore:
        '!dist/\n!dist/index.ts\n!src/generated/\n!src/generated/schema.ts\n!cwconfig.json\n',
    });

    await initFilter(repoRoot);

    expect(isFiltered('dist/index.ts')).toBe(false);
    expect(isFiltered('src/generated/schema.ts')).toBe(true);
    expect(isFiltered('cwconfig.json')).toBe(true);
  });

  it('aborts initialization when cwconfig.json is invalid', async () => {
    const repoRoot = await createRepo();
    await fs.writeFile(path.join(repoRoot, 'cwconfig.json'), '{ invalid json', 'utf-8');

    await expect(initFilter(repoRoot)).rejects.toThrow('cwconfig.json');
  });

  it('crawler returns only files inside configured include scope', async () => {
    const repoRoot = await createRepo({
      cwconfig: {
        indexing: {
          includePatterns: ['src/**', 'packages/*/src/**', 'dist/**', 'logs/**'],
          ignorePatterns: ['src/generated/**'],
        },
      },
      gitignore: 'logs/\n',
    });

    await initFilter(repoRoot);
    const result = await crawl(repoRoot);
    const relativePaths = result.relativePaths.sort();

    expect(relativePaths).toEqual([
      'dist/index.ts',
      'packages/core/src/index.ts',
      'src/app.ts',
      'src/nested/deep/file.ts',
    ]);
  });
});
