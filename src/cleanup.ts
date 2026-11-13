import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";

export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Remove every file under `root` that was not touched for `maxAgeMs`, and the folders that end up empty. Working
 * files are rewritten when they are used, or touched when they are reused, so what is old is not in use. A folder
 * that is empty but recent is left alone, since another window may be about to write into it. Symbolic links are
 * never followed. Returns how many files were removed.
 */
export async function cleanStorage(root: string, maxAgeMs = MAX_AGE_MS, now = Date.now()): Promise<number> {
  let removed = 0;
  const visit = async (directory: string, isRoot: boolean) => {
    let entries;
    let modified: number;
    try {
      entries = await readdir(directory, { withFileTypes: true });
      modified = (await lstat(directory)).mtimeMs;
    } catch {
      return; // Missing, or not readable.
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path, false);
        continue;
      }
      try {
        if (now - (await lstat(path)).mtimeMs > maxAgeMs) {
          await unlink(path);
          removed++;
        }
      } catch {
        // Gone already, or in use.
      }
    }
    // The age of the folder is read before removing its files, which changes it.
    if (!isRoot && now - modified > maxAgeMs) {
      try {
        await rmdir(directory); // Fails, as wanted, unless the folder is empty.
      } catch {
        // Not empty.
      }
    }
  };
  await visit(root, true);
  return removed;
}
