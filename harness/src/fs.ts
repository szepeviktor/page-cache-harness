import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function resetDir(dir: string): Promise<void> {
  await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { recursive: true });
}

export async function copyDir(from: string, to: string): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
}

export async function writeTextFile(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}
