import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

function chmodSyncIfExists(targetPath: string, mode: number): void {
  try {
    fs.chmodSync(targetPath, mode);
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code !== 'ENOENT') {
      throw err;
    }
  }
}

async function chmodIfExists(targetPath: string, mode: number): Promise<void> {
  try {
    await fsp.chmod(targetPath, mode);
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code !== 'ENOENT') {
      throw err;
    }
  }
}

export function ensurePrivateDirSync(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodSyncIfExists(dirPath, PRIVATE_DIR_MODE);
}

export async function ensurePrivateDir(dirPath: string): Promise<void> {
  await fsp.mkdir(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });
  await chmodIfExists(dirPath, PRIVATE_DIR_MODE);
}

export function writePrivateFileSync(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  options?: { flag?: string },
): void {
  ensurePrivateDirSync(path.dirname(filePath));
  fs.writeFileSync(filePath, data, { flag: options?.flag ?? 'w', mode: PRIVATE_FILE_MODE });
  chmodSyncIfExists(filePath, PRIVATE_FILE_MODE);
}

export async function writePrivateFile(filePath: string, data: string): Promise<void> {
  await ensurePrivateDir(path.dirname(filePath));
  await fsp.writeFile(filePath, data, { mode: PRIVATE_FILE_MODE });
  await chmodIfExists(filePath, PRIVATE_FILE_MODE);
}

export function createPrivateAppendStream(filePath: string): fs.WriteStream {
  ensurePrivateDirSync(path.dirname(filePath));
  chmodSyncIfExists(filePath, PRIVATE_FILE_MODE);
  return fs.createWriteStream(filePath, { flags: 'a', mode: PRIVATE_FILE_MODE });
}

export function hardenPrivatePathSync(targetPath: string): void {
  try {
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink()) {
      return;
    }
    fs.chmodSync(targetPath, stat.isDirectory() ? PRIVATE_DIR_MODE : PRIVATE_FILE_MODE);
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code !== 'ENOENT') {
      throw err;
    }
  }
}

export async function hardenPrivatePath(targetPath: string): Promise<void> {
  try {
    const stat = await fsp.lstat(targetPath);
    if (stat.isSymbolicLink()) {
      return;
    }
    await fsp.chmod(targetPath, stat.isDirectory() ? PRIVATE_DIR_MODE : PRIVATE_FILE_MODE);
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code !== 'ENOENT') {
      throw err;
    }
  }
}

export function hardenPrivateTreeSync(rootPath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(rootPath);
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') {
      return;
    }
    throw err;
  }

  if (stat.isSymbolicLink()) {
    return;
  }

  fs.chmodSync(rootPath, stat.isDirectory() ? PRIVATE_DIR_MODE : PRIVATE_FILE_MODE);
  if (!stat.isDirectory()) {
    return;
  }

  for (const entry of fs.readdirSync(rootPath)) {
    hardenPrivateTreeSync(path.join(rootPath, entry));
  }
}
