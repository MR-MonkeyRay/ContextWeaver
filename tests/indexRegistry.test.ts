import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findStaleIndexedProjects,
  isIndexedProjectConfirmed,
  listIndexedProjects,
  markIndexedProjectConfirmed,
  removeIndexedProjects,
  upsertIndexedProject,
} from '../src/indexRegistry.js';

const tempDirs: string[] = [];
let previousHome: string | undefined;
let registryPath = '';

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(async () => {
  previousHome = process.env.HOME;
  const fakeHome = await createTempDir('cw-home-');
  process.env.HOME = fakeHome;
  registryPath = path.join(fakeHome, '.contextweaver', 'indexes.json');
});

afterEach(async () => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }

  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('indexRegistry', () => {
  it('returns an empty list when the registry file is missing', async () => {
    await expect(listIndexedProjects()).resolves.toEqual([]);
  });

  it('stores absolute project paths and updates lastIndexedAt on upsert', async () => {
    const repoRoot = await createTempDir('cw-repo-');

    await upsertIndexedProject({
      projectId: 'abc123def0',
      projectPath: repoRoot,
      pathBirthtimeMs: 1,
      lastIndexedAt: '2026-03-27T00:00:00.000Z',
    });
    await upsertIndexedProject({
      projectId: 'abc123def0',
      projectPath: repoRoot,
      pathBirthtimeMs: 1,
      lastIndexedAt: '2026-03-27T00:00:01.000Z',
    });

    await expect(listIndexedProjects()).resolves.toEqual([
      {
        projectId: 'abc123def0',
        projectPath: path.resolve(repoRoot),
        pathBirthtimeMs: 1,
        lastIndexedAt: '2026-03-27T00:00:01.000Z',
        confirmedAt: null,
      },
    ]);
  });

  it('stores the registry under a private directory and file mode', async () => {
    const previousUmask = process.umask(0o002);
    try {
      const repoRoot = await createTempDir('cw-repo-');

      await upsertIndexedProject({
        projectId: 'abc123def0',
        projectPath: repoRoot,
        pathBirthtimeMs: 1,
        lastIndexedAt: '2026-03-27T00:00:00.000Z',
      });

      const baseMode = (await fs.stat(path.dirname(registryPath))).mode & 0o777;
      const fileMode = (await fs.stat(registryPath)).mode & 0o777;

      expect(baseMode).toBe(0o700);
      expect(fileMode).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }
  });

  it('hardens an existing permissive registry directory and file', async () => {
    await fs.mkdir(path.dirname(registryPath), { recursive: true, mode: 0o777 });
    await fs.writeFile(registryPath, '{"version":1,"indexes":[]}\n', {
      encoding: 'utf-8',
      mode: 0o666,
    });
    await fs.chmod(path.dirname(registryPath), 0o777);
    await fs.chmod(registryPath, 0o666);

    const repoRoot = await createTempDir('cw-repo-');
    await upsertIndexedProject({
      projectId: 'abc123def0',
      projectPath: repoRoot,
      pathBirthtimeMs: 1,
      lastIndexedAt: '2026-03-27T00:00:00.000Z',
    });

    expect((await fs.stat(path.dirname(registryPath))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(registryPath)).mode & 0o777).toBe(0o600);
  });

  it('stores and updates confirmedAt for an indexed project', async () => {
    const repoRoot = await createTempDir('cw-repo-');

    await upsertIndexedProject({
      projectId: 'abc123def0',
      projectPath: repoRoot,
      pathBirthtimeMs: 1,
      lastIndexedAt: '2026-03-27T00:00:00.000Z',
      confirmedAt: null,
    });

    await markIndexedProjectConfirmed('abc123def0', '2026-03-27T00:00:01.000Z');
    const projects = await listIndexedProjects();
    expect(projects[0]?.confirmedAt).toBe('2026-03-27T00:00:01.000Z');
  });

  it('reports whether a project has completed a confirmed indexing run', async () => {
    await expect(isIndexedProjectConfirmed('abc123def0')).resolves.toBe(false);
  });

  it('treats old registry entries without confirmedAt as unconfirmed', async () => {
    const repoRoot = await createTempDir('cw-repo-');
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(
      registryPath,
      `${JSON.stringify(
        {
          version: 1,
          indexes: [
            {
              projectId: 'abc123def0',
              projectPath: repoRoot,
              pathBirthtimeMs: 1,
              lastIndexedAt: '2026-03-27T00:00:00.000Z',
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );

    await expect(listIndexedProjects()).resolves.toEqual([
      {
        projectId: 'abc123def0',
        projectPath: path.resolve(repoRoot),
        pathBirthtimeMs: 1,
        lastIndexedAt: '2026-03-27T00:00:00.000Z',
        confirmedAt: null,
      },
    ]);
    await expect(isIndexedProjectConfirmed('abc123def0')).resolves.toBe(false);
  });

  it('detects stale projects when the stored path is missing', async () => {
    const missingPath = path.join(process.env.HOME || '', 'missing-repo');

    await upsertIndexedProject({
      projectId: 'abc123def0',
      projectPath: missingPath,
      pathBirthtimeMs: 1,
      lastIndexedAt: '2026-03-27T00:00:00.000Z',
    });

    await expect(findStaleIndexedProjects()).resolves.toEqual([
      {
        projectId: 'abc123def0',
        projectPath: path.resolve(missingPath),
        pathBirthtimeMs: 1,
        lastIndexedAt: '2026-03-27T00:00:00.000Z',
        confirmedAt: null,
      },
    ]);
  });

  it('detects stale projects when a different repo exists at the same path', async () => {
    const repoRoot = await createTempDir('cw-repo-');

    await upsertIndexedProject({
      projectId: 'abc123def0',
      projectPath: repoRoot,
      pathBirthtimeMs: Number.MAX_SAFE_INTEGER,
      lastIndexedAt: '2026-03-27T00:00:00.000Z',
    });

    const stale = await findStaleIndexedProjects();

    expect(stale[0]?.projectId).toBe('abc123def0');
  });

  it('removes records by project id', async () => {
    const repoRoot = await createTempDir('cw-repo-');

    await upsertIndexedProject({
      projectId: 'abc123def0',
      projectPath: repoRoot,
      pathBirthtimeMs: 1,
      lastIndexedAt: '2026-03-27T00:00:00.000Z',
    });

    await removeIndexedProjects(['abc123def0']);

    await expect(listIndexedProjects()).resolves.toEqual([]);
  });

  it('throws on malformed registry content', async () => {
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, '{ invalid json', 'utf-8');

    await expect(listIndexedProjects()).rejects.toThrow('indexes.json');
  });

  it('keeps registry removal safe when the index directory is already missing', async () => {
    const missingPath = path.join(process.env.HOME || '', 'missing-repo');

    await upsertIndexedProject({
      projectId: 'missing12345',
      projectPath: missingPath,
      pathBirthtimeMs: 1,
      lastIndexedAt: '2026-03-27T00:00:00.000Z',
    });

    await removeIndexedProjects(['missing12345']);

    await expect(listIndexedProjects()).resolves.toEqual([]);
  });
});
