import { stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as vscode from "vscode";

const CPPTOOLS = "ms-vscode.cpptools";
const DAY_MS = 24 * 60 * 60 * 1000;

let counter = 0;

/**
 * Put a text where the C/C++ extension can analyze it: a new file, opened as a hidden document. A new file for
 * every text means the document always matches the disk, so nothing has to be edited or saved through the editor
 * (that would open an unsaved tab, or conflict with a file that changed on disk).
 */
export async function openScratch(dir: string, base: string, extension: string, text: string): Promise<string> {
  const path = join(dir, `${base}-${Date.now()}-${counter++}${extension}`);
  await writeFile(path, text);
  try {
    await vscode.workspace.openTextDocument(vscode.Uri.file(path));
  } catch (error) {
    await removeScratch(path);
    throw error;
  }
  return path;
}

export async function removeScratch(path: string) {
  try {
    await unlink(path);
  } catch {
    // Already gone.
  }
}

/** Refresh the modification time of a file that is being reused, so that the storage cleanup does not take it. */
export async function touch(path: string) {
  try {
    if (Date.now() - (await stat(path)).mtimeMs > DAY_MS) {
      const now = new Date();
      await utimes(path, now, now);
    }
  } catch {
    // Gone: the caller notices on its own.
  }
}

/** The result of a promise, or undefined if it takes longer than `ms`. */
export function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), Math.max(ms, 0));
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Wake up the C/C++ extension. Opening a C file does that too, but only after the request that needs it, which
 * would then find no language features yet.
 */
export async function activateCppTools(): Promise<boolean> {
  const extension = vscode.extensions.getExtension(CPPTOOLS);
  if (!extension) {
    return false;
  }
  if (!extension.isActive) {
    await extension.activate();
  }
  return true;
}
