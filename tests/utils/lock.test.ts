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
});
