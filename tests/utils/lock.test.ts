import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let previousHome: string | undefined;
let tempHome: string;

async function loadLockModule(): Promise<typeof import('../../src/utils/lock.js')> {
  vi.resetModules();
  return import('../../src/utils/lock.js');
}

function lockPath(projectId: string): string {
  return path.join(tempHome, '.contextweaver', projectId, 'index.lock');
}

beforeEach(async () => {
  previousHome = process.env.HOME;
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-lock-home-'));
  process.env.HOME = tempHome;
});

afterEach(async () => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }

  await fs.rm(tempHome, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('withLock', () => {
  it('creates lock directories and lock files with private permissions', async () => {
    const previousUmask = process.umask(0o002);
    try {
      const { withLock } = await loadLockModule();
      const projectId = 'private-lock';

      await withLock(projectId, 'index', async () => {
        const projectDir = path.dirname(lockPath(projectId));
        const baseDir = path.dirname(projectDir);
        const baseMode = (await fs.stat(baseDir)).mode & 0o777;
        const dirMode = (await fs.stat(projectDir)).mode & 0o777;
        const fileMode = (await fs.stat(lockPath(projectId))).mode & 0o777;

        expect(baseMode).toBe(0o700);
        expect(dirMode).toBe(0o700);
        expect(fileMode).toBe(0o600);
      });
    } finally {
      process.umask(previousUmask);
    }
  });

  it('reports active locks and releases only the token it owns', async () => {
    const { isProjectLocked, withLock } = await loadLockModule();
    const projectId = 'token-owned';

    await withLock(projectId, 'index', async () => {
      expect(isProjectLocked(projectId)).toBe(true);

      const currentLock = JSON.parse(await fs.readFile(lockPath(projectId), 'utf-8')) as {
        operation: string;
      };

      await fs.writeFile(
        lockPath(projectId),
        JSON.stringify({
          ...currentLock,
          pid: process.pid,
          timestamp: Date.now(),
          token: 'other-owner-token',
        }),
        'utf-8',
      );
    });

    await expect(fs.readFile(lockPath(projectId), 'utf-8')).resolves.toContain('other-owner-token');
  });

  it('treats stale locks as unlocked and replaces them on acquisition', async () => {
    const { isProjectLocked, withLock } = await loadLockModule();
    const projectId = 'stale-lock';
    const targetLockPath = lockPath(projectId);
    await fs.mkdir(path.dirname(targetLockPath), { recursive: true });
    await fs.writeFile(
      targetLockPath,
      JSON.stringify({
        pid: process.pid,
        timestamp: Date.now() - 6 * 60 * 1000,
        operation: 'index',
        token: 'stale-token',
      }),
      'utf-8',
    );

    expect(isProjectLocked(projectId)).toBe(false);

    await withLock(projectId, 'index', async () => {
      const content = await fs.readFile(targetLockPath, 'utf-8');
      expect(content).not.toContain('stale-token');
      expect(isProjectLocked(projectId)).toBe(true);
    });

    await expect(fs.access(targetLockPath)).rejects.toThrow();
  });
  it('aborts promptly while waiting for a held lock', async () => {
    const { withLock } = await loadLockModule();
    const projectId = 'cancel-wait';
    let release: (() => void) | undefined;
    const held = withLock(
      projectId,
      'index',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await vi.waitFor(() => fs.access(lockPath(projectId)));

    const controller = new AbortController();
    const waiting = withLock(projectId, 'index', async () => {}, 10_000, controller.signal);
    controller.abort();

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    release?.();
    await held;
  });
});
