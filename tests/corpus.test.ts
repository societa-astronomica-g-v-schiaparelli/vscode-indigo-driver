import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { lint } from "../src/lint";
import { parse } from "../src/parser";

const repo = process.env.INDIGO_REPO;

function findDrivers(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (entry === "node_modules" || entry === ".git") {
      return [];
    }
    if (statSync(path).isDirectory()) {
      return findDrivers(path);
    }
    // template.driver is a catalog full of XXXXX placeholders, not a valid driver.
    return path.endsWith(".driver") && entry !== "template.driver" ? [path] : [];
  });
}

// Set INDIGO_REPO to a checkout of the INDIGO repository to run the parser on every real .driver file.
describe.skipIf(!repo || !existsSync(repo))("INDIGO corpus", () => {
  const files = repo && existsSync(repo) ? findDrivers(repo) : [];

  it("finds driver files", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files)("parses %s without problems", (file) => {
    const { root, problems } = parse(readFileSync(file, "utf8"));
    expect(root).toBeDefined();
    expect(problems).toEqual([]);
  });
});

describe.skipIf(!repo || !existsSync(repo))("INDIGO corpus lint", () => {
  const files = repo && existsSync(repo) ? findDrivers(repo) : [];

  it.each(files)("reports no errors for %s", (file) => {
    const text = readFileSync(file, "utf8");
    const { root } = parse(text);
    const found = root ? lint(root, text) : [];
    expect(found.filter((p) => p.severity === "error")).toEqual([]);
  });
});
