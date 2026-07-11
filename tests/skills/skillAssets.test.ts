import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const tempDirs: string[] = [];

async function read(relativePath: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, relativePath), 'utf-8');
}

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('skill assets', () => {
  it('keeps conditional grammar packages optional and shipped docs available', async () => {
    const pkg = JSON.parse(await read('package.json')) as {
      dependencies?: Record<string, string>;
      files?: string[];
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      pnpm?: { peerDependencyRules?: { ignoreMissing?: string[] } };
    };

    expect(pkg.files).toContain('skills/**/*');
    expect(pkg.files).toContain('docs/**/*.md');
    for (const packageName of ['tree-sitter-dart', 'tree-sitter-kotlin', 'tree-sitter-swift']) {
      expect(pkg.dependencies).not.toHaveProperty(packageName);
      expect(pkg.optionalDependencies ?? {}).not.toHaveProperty(packageName);
      expect(pkg.peerDependencies ?? {}).not.toHaveProperty(packageName);
    }
    expect(pkg.pnpm?.peerDependencyRules?.ignoreMissing).toContain('tree-sitter');
  });

  it('ships a Chinese using-contextweaver skill backed by a local script', async () => {
    const content = await read('skills/using-contextweaver/SKILL.md');
    const scriptPath = path.join(repoRoot, 'skills/using-contextweaver/scripts/search-context.mjs');

    expect(content).toContain('---');
    expect(content).toContain('name: using-contextweaver');
    expect(content).toContain('description: >-');
    expect(content).toContain('需要理解代码库中功能如何实现');
    expect(content).toContain('使用 ContextWeaver');
    expect(content).toContain('contextweaver search');
    expect(content).toContain('Agent 必须主动执行初始化恢复');
    expect(content).toContain('contextweaver index /abs/path/to/repo --yes');
    expect(content).not.toContain('contextweaver_codebase-retrieval');
    await expect(fs.access(scriptPath)).resolves.toBeUndefined();
  });

  it('ships an enhancing-prompts skill with script and Chinese templates', async () => {
    const skill = await read('skills/enhancing-prompts/SKILL.md');
    const agentTemplate = await read('skills/enhancing-prompts/templates/agent-template.zh.md');
    const questionTemplate = await read(
      'skills/enhancing-prompts/templates/question-template.zh.md',
    );
    const scriptPath = path.join(
      repoRoot,
      'skills/enhancing-prompts/scripts/prepare-enhancement-context.mjs',
    );

    expect(skill).toContain('name: enhancing-prompts');
    expect(skill).toContain('description: Use when');
    expect(skill).toContain('提示词增强');
    expect(skill).toContain('Question');
    expect(skill).toContain('最终任务 prompt');
    expect(agentTemplate).toContain('推荐任务解释');
    expect(agentTemplate).toContain('仓库证据');
    expect(questionTemplate).toContain('提问条件');
    await expect(fs.access(scriptPath)).resolves.toBeUndefined();
  });

  it('passes json by default and respects explicit text format in helper scripts', async () => {
    const tempDir = await createTempDir('cw-skill-script-');
    const capturePath = path.join(tempDir, 'args.json');
    const stubPath = path.join(tempDir, 'contextweaver-stub.mjs');

    await fs.writeFile(
      stubPath,
      [
        '#!/usr/bin/env node',
        "import fs from 'node:fs';",
        `fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.argv.slice(2)));`,
      ].join('\n'),
      'utf-8',
    );
    await fs.chmod(stubPath, 0o755);

    const scripts = [
      path.join(repoRoot, 'skills/using-contextweaver/scripts/search-context.mjs'),
      path.join(repoRoot, 'skills/enhancing-prompts/scripts/prepare-enhancement-context.mjs'),
    ];

    for (const scriptPath of scripts) {
      const baseArgs = scriptPath.includes('search-context')
        ? ['--repo-path', '/tmp/repo', '--information-request', 'test prompt']
        : ['--repo-path', '/tmp/repo', 'test prompt'];
      const commandName = scriptPath.includes('search-context') ? 'search' : 'prompt-context';

      const defaultRun = spawnSync(process.execPath, [scriptPath, ...baseArgs], {
        env: { ...process.env, CONTEXTWEAVER_BIN: stubPath },
        encoding: 'utf-8',
      });

      expect(defaultRun.status).toBe(0);

      const defaultArgs = JSON.parse(await fs.readFile(capturePath, 'utf-8')) as string[];
      expect(defaultArgs.slice(0, 4)).toEqual([commandName, '--format', 'json', '--repo-path']);

      const textRun = spawnSync(process.execPath, [scriptPath, '--format', 'text', ...baseArgs], {
        env: { ...process.env, CONTEXTWEAVER_BIN: stubPath },
        encoding: 'utf-8',
      });

      expect(textRun.status).toBe(0);

      const textArgs = JSON.parse(await fs.readFile(capturePath, 'utf-8')) as string[];
      expect(textArgs).toContain(commandName);
      const formatIndex = textArgs.indexOf('--format');
      expect(formatIndex).toBeGreaterThanOrEqual(0);
      expect(textArgs[formatIndex + 1]).toBe('text');
      expect(textArgs.filter((arg) => arg === '--format')).toHaveLength(1);
    }
  });
});
