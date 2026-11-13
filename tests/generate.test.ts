import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveExecutable, runGenerator } from "../src/generate";

let root: string;
let savedPath: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "indigo-generate-"));
  savedPath = process.env.PATH;
});
afterEach(() => {
  process.env.PATH = savedPath;
  rmSync(root, { recursive: true, force: true });
});

function script(directory: string, name: string, body: string) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe.skipIf(process.platform === "win32")("resolveExecutable", () => {
  it("finds a command in PATH", () => {
    const path = script(join(root, "bin"), "gen", "exit 0");
    process.env.PATH = [join(root, "elsewhere"), join(root, "bin")].join(delimiter);
    expect(resolveExecutable("gen")).toBe(path);
  });

  it("never looks in the current folder or an empty PATH entry", () => {
    script(root, "gen", "exit 0");
    process.env.PATH = ["", join(root, "other")].join(delimiter);
    const before = process.cwd();
    process.chdir(root);
    try {
      expect(resolveExecutable("gen")).toBeUndefined();
    } finally {
      process.chdir(before);
    }
  });

  it("uses a path as it is", () => {
    expect(resolveExecutable("/opt/indigo/indigo_generator")).toBe("/opt/indigo/indigo_generator");
  });
});

describe.skipIf(process.platform === "win32")("runGenerator", () => {
  it("reports a command that is not in PATH as missing, without starting anything", async () => {
    process.env.PATH = join(root, "empty");
    const result = await runGenerator("indigo_generator", join(root, "x.driver"), root);
    expect(result.missing).toBe(true);
    expect(result.output).toContain("not found in PATH");
  });

  it("runs the program in the given folder and returns its output", async () => {
    const path = script(join(root, "bin"), "gen", 'echo "ran in $(pwd) on $1"');
    const result = await runGenerator(path, "file.driver", root);
    expect(result).toMatchObject({ code: 0, missing: false });
    expect(result.output).toContain("on file.driver");
  });

  it("returns the exit code and what the program printed on failure", async () => {
    const path = script(join(root, "bin"), "gen", "echo 'ERROR (1:1): bad' >&2; exit 3");
    const result = await runGenerator(path, "file.driver", root);
    expect(result.code).toBe(3);
    expect(result.output).toContain("ERROR (1:1): bad");
  });
});
