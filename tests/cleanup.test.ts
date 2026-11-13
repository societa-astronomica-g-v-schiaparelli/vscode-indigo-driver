import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cleanStorage, MAX_AGE_MS } from "../src/cleanup";

const DAY = 24 * 60 * 60 * 1000;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "indigo-cleanup-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function file(path: string, ageDays: number) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x");
  const time = (Date.now() - ageDays * DAY) / 1000;
  utimesSync(path, time, time);
  // A folder is as old as the last thing written into it, and its parents are not younger.
  for (let folder = join(path, ".."); folder.length > root.length; folder = join(folder, "..")) {
    utimesSync(folder, time, time);
  }
}

describe("cleanStorage", () => {
  it("removes files older than the limit and keeps the recent ones", async () => {
    file(join(root, "shadow", "a", "old.c"), 31);
    file(join(root, "shadow", "a", "recent.c"), 29);
    expect(await cleanStorage(root)).toBe(1);
    expect(existsSync(join(root, "shadow", "a", "old.c"))).toBe(false);
    expect(existsSync(join(root, "shadow", "a", "recent.c"))).toBe(true);
  });

  it("removes a stale file inside a folder that is otherwise in use", async () => {
    file(join(root, "format", "h", "scratch.c"), 60);
    file(join(root, "format", "h", ".clang-format"), 0);
    await cleanStorage(root);
    expect(existsSync(join(root, "format", "h", "scratch.c"))).toBe(false);
    expect(existsSync(join(root, "format", "h", ".clang-format"))).toBe(true);
  });

  it("removes folders that end up empty, but keeps the root", async () => {
    file(join(root, "shadow", "b", "generator", "old.c"), 90);
    expect(await cleanStorage(root)).toBe(1);
    expect(existsSync(join(root, "shadow"))).toBe(false);
    expect(existsSync(root)).toBe(true);
  });

  it("keeps an empty folder that is recent, in case another window is about to write into it", async () => {
    mkdirSync(join(root, "shadow", "fresh"), { recursive: true });
    await cleanStorage(root);
    expect(existsSync(join(root, "shadow", "fresh"))).toBe(true);
  });

  it("keeps a folder that still holds something recent", async () => {
    file(join(root, "shadow", "c", "generator", "old.c"), 90);
    file(join(root, "shadow", "c", "fresh.h"), 1);
    await cleanStorage(root);
    expect(existsSync(join(root, "shadow", "c", "generator"))).toBe(false);
    expect(existsSync(join(root, "shadow", "c", "fresh.h"))).toBe(true);
  });

  it("does not follow symbolic links out of the storage", async () => {
    const outside = mkdtempSync(join(tmpdir(), "indigo-outside-"));
    try {
      file(join(outside, "precious.txt"), 400);
      symlinkSync(outside, join(root, "link"));
      await cleanStorage(root);
      expect(existsSync(join(outside, "precious.txt"))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does nothing for a missing folder", async () => {
    expect(await cleanStorage(join(root, "nothing"))).toBe(0);
  });

  it("uses 30 days by default", () => {
    expect(MAX_AGE_MS).toBe(30 * DAY);
  });
});
