import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { analyze } from "../src/analysis";

let hoverCalls = 0;
const hoverAnswers: (object[] | undefined)[] = [];
// Documents the fake editor holds open, as `workspace.textDocuments` would list them.
const openDocuments: { uri: { fsPath: string } }[] = [];

vi.mock("vscode", () => ({
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  Uri: { file: (path: string) => ({ fsPath: path, scheme: "file", toString: () => `file://${path}` }) },
  workspace: {
    isTrusted: true,
    getConfiguration: () => ({ get: (_key: string, fallback: string) => process.env.INDIGO_GENERATOR ?? fallback }),
    get textDocuments() {
      return openDocuments;
    },
    openTextDocument: async (uri: { fsPath: string }): Promise<object> => {
      openDocuments.push({ uri });
      return {};
    },
  },
  window: { showWarningMessage: (): undefined => undefined },
  Position: class {
    constructor(
      public line: number,
      public character: number,
    ) {}
  },
  extensions: { getExtension: () => ({ isActive: true, activate: async (): Promise<void> => undefined }) },
  commands: {
    executeCommand: async (command: string) => {
      hoverCalls++;
      return command === "vscode.executeHoverProvider" ? hoverAnswers.shift() : undefined;
    },
  },
}));

const { findProbe, ShadowSource } = await import("../src/shadow");

const fixture = readFileSync(new URL("./fixtures/acmeflat.driver", import.meta.url), "utf8");
const root = mkdtempSync(join(tmpdir(), "indigo-shadow-source-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Set INDIGO_GENERATOR to a built indigo_generator to run the whole generation with the real tool.
describe.skipIf(!process.env.INDIGO_GENERATOR)("ShadowSource with the real indigo_generator", () => {
  const fileName = join(root, "work", "acmeflat.driver");
  mkdirSync(join(root, "work"), { recursive: true });
  writeFileSync(fileName, fixture);

  const documentWith = (text: string, version: number) =>
    ({
      fileName,
      version,
      getText: () => text,
      uri: { scheme: "file", toString: () => `file://${fileName}` },
    }) as never;
  const output = { appendLine: (): undefined => undefined } as never;
  let current = fixture;
  let version = 1;
  const cache = { get: () => analyze(current) } as never;
  // The fake C/C++ extension never answers, so keep the wait short.
  const shadow = new ShadowSource({ fsPath: join(root, "storage") } as never, cache, output, {
    timeoutMs: 20,
    intervalMs: 5,
  });

  it("generates a copy with its header and maps every code block", async () => {
    const state = (await shadow.sync(documentWith(current, version)))!;
    // data, code, on_connect and the switch on_change: the other code blocks of the fixture are empty.
    expect(state.map.size).toBe(4);
    const path = state.uri.fsPath;
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(path, "..", "indigo_aux_acmeflat.h"))).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("acmeflat_command");
    expect(shadow.originOf(path)).toBe(join(root, "work"));
  });

  it("reuses the file when only positions changed", async () => {
    const first = (await shadow.sync(documentWith(current, version)))!;
    current = `// a comment that moves everything down\n${fixture}`;
    version++;
    const second = (await shadow.sync(documentWith(current, version)))!;
    expect(second.uri.fsPath).toBe(first.uri.fsPath);
    expect(second.map.toGenerated({ line: 0, col: 0 })).toBeUndefined();
  });

  it("uses a new file when the generated code changed, and removes the old one", async () => {
    const before = (await shadow.sync(documentWith(current, version)))!;
    current = fixture.replace('acmeflat_command(device, "V")', 'acmeflat_command(device, "W")');
    version++;
    const after = (await shadow.sync(documentWith(current, version)))!;
    expect(after.uri.fsPath).not.toBe(before.uri.fsPath);
    expect(existsSync(before.uri.fsPath)).toBe(false);
    expect(readFileSync(after.uri.fsPath, "utf8")).toContain('"W"');
    expect(shadow.originOf(before.uri.fsPath)).toBeUndefined();
  });

  it("gives up on a definition with syntax errors", async () => {
    current = "driver acmeflat {";
    version++;
    expect(await shadow.sync(documentWith(current, version))).toBeUndefined();
  });
});

describe("findProbe", () => {
  it("points at the entry point of the generated driver", () => {
    const text = "#include <x>\n\nindigo_result indigo_aux_acme(indigo_driver_action action) {\n}";
    expect(findProbe(text)).toEqual({ line: 2, col: 14 });
  });

  it("falls back to the DRIVER_NAME macro", () => {
    expect(findProbe('// a\n#define DRIVER_NAME "x"\n')).toEqual({ line: 1, col: 8 });
  });

  it("gives up when there is nothing to ask about", () => {
    expect(findProbe("int x;")).toBeUndefined();
  });
});

describe("ShadowSource notes", () => {
  it("writes each reason once per file, and again after the problem went away", () => {
    const lines: string[] = [];
    const shadow = new ShadowSource(
      { fsPath: join(root, "n") } as never,
      {} as never,
      { appendLine: (l: string) => lines.push(l) } as never,
    );
    const document = (name: string) =>
      ({ fileName: join(root, name), uri: { toString: () => `file://${name}` } }) as never;
    shadow.note(document("a.driver"), "off");
    shadow.note(document("a.driver"), "off");
    shadow.note(document("b.driver"), "off");
    expect(lines).toEqual(["a.driver: off", "b.driver: off"]);
  });
});

describe.skipIf(!process.env.INDIGO_GENERATOR)("ShadowSource waiting for the C/C++ extension", () => {
  const fileName = join(root, "wait", "acmeflat.driver");
  mkdirSync(join(root, "wait"), { recursive: true });
  writeFileSync(fileName, fixture);
  const document = (text: string, version: number) =>
    ({
      fileName,
      version,
      getText: () => text,
      uri: { scheme: "file", toString: () => `file://${fileName}` },
    }) as never;
  const lines: string[] = [];
  const make = (wait: { timeoutMs: number; intervalMs: number }) =>
    new ShadowSource(
      { fsPath: join(root, "wait-storage") } as never,
      { get: (d: { getText(): string }) => analyze(d.getText()) } as never,
      { appendLine: (l: string) => lines.push(l) } as never,
      wait,
    );

  it("asks about the generated file until the C/C++ extension answers", async () => {
    hoverCalls = 0;
    hoverAnswers.length = 0;
    hoverAnswers.push(undefined, [], [{}]);
    const state = await make({ timeoutMs: 5000, intervalMs: 5 }).sync(document(fixture, 1));
    expect(state).toBeDefined();
    expect(hoverCalls).toBe(3);
  });

  it("does not ask again for a file with the same generated code", async () => {
    hoverCalls = 0;
    hoverAnswers.length = 0;
    hoverAnswers.push([{}]);
    const shadow = make({ timeoutMs: 5000, intervalMs: 5 });
    await shadow.sync(document(fixture, 1));
    await shadow.sync(document(`// moved\n${fixture}`, 2));
    expect(hoverCalls).toBe(1);
  });

  it("stops waiting for a while when the probe gets no answer in time", async () => {
    hoverCalls = 0;
    hoverAnswers.length = 0;
    lines.length = 0;
    const shadow = make({ timeoutMs: 40, intervalMs: 10 });
    expect(await shadow.sync(document(fixture, 1))).toBeDefined();
    const calls = hoverCalls;
    expect(calls).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("will not wait for it for the next 5 minutes");
    expect(await shadow.sync(document(fixture.replace('"V"', '"W"'), 2))).toBeDefined();
    expect(hoverCalls).toBe(calls);
  });
});

describe.skipIf(!process.env.INDIGO_GENERATOR)("ShadowSource with several requests and documents", () => {
  const fileName = join(root, "many", "acmeflat.driver");
  mkdirSync(join(root, "many"), { recursive: true });
  writeFileSync(fileName, fixture);
  const document = (text: string, version: number) =>
    ({
      fileName,
      version,
      getText: () => text,
      uri: { scheme: "file", toString: () => `file://${fileName}` },
    }) as never;
  const output = { appendLine: (): undefined => undefined } as never;
  const cache = { get: (d: { getText(): string }) => analyze(d.getText()) } as never;
  const wait = { timeoutMs: 20, intervalMs: 5 };
  const withMarker = (marker: string) =>
    fixture.replace('acmeflat_command(device, "V")', `acmeflat_command(device, "${marker}")`);
  const shadowFiles = (storage: string) => {
    const dir = join(storage, "shadow");
    return readdirSync(dir).flatMap((d) => readdirSync(join(dir, d)).filter((f) => /^shadow-.*\.c$/.test(f)));
  };

  it("keeps requests for a changing document in order: one published file, and a state for the latest text", async () => {
    const storage = join(root, "storage-concurrent");
    const shadow = new ShadowSource({ fsPath: storage } as never, cache, output, wait);
    const first = shadow.sync(document(withMarker("A"), 1));
    const second = shadow.sync(document(withMarker("B"), 2));
    const [one, two] = await Promise.all([first, second]);
    expect(one?.text).toContain('"A"');
    expect(two?.text).toContain('"B"');
    expect(readFileSync(two!.uri.fsPath, "utf8")).toContain('"B"');
    expect(shadowFiles(storage)).toHaveLength(1);
  });

  it("starts from nothing when a document is closed and opened again with another text", async () => {
    const storage = join(root, "storage-reopen");
    const shadow = new ShadowSource({ fsPath: storage } as never, cache, output, wait);
    const before = (await shadow.sync(document(withMarker("A"), 1)))!;
    await shadow.evict(document(withMarker("A"), 1));
    expect(existsSync(before.uri.fsPath)).toBe(false);
    // Version 1 again, as after a reopen, but the file on disk is a different one.
    const after = (await shadow.sync(document(withMarker("B"), 1)))!;
    expect(readFileSync(after.uri.fsPath, "utf8")).toContain('"B"');
    expect(after.text).toContain('"B"');
  });

  it("does not trust a state of the same version when the text is not the same", async () => {
    const shadow = new ShadowSource({ fsPath: join(root, "storage-text") } as never, cache, output, wait);
    await shadow.sync(document(withMarker("A"), 1));
    const other = (await shadow.sync(document(withMarker("B"), 1)))!;
    expect(readFileSync(other.uri.fsPath, "utf8")).toContain('"B"');
  });

  it("makes a new file when the published one has disappeared", async () => {
    const shadow = new ShadowSource({ fsPath: join(root, "storage-gone") } as never, cache, output, wait);
    const first = (await shadow.sync(document(fixture, 1)))!;
    rmSync(first.uri.fsPath);
    const second = (await shadow.sync(document(`// moved\n${fixture}`, 2)))!;
    expect(existsSync(second.uri.fsPath)).toBe(true);
    expect(second.uri.fsPath).not.toBe(first.uri.fsPath);
  });

  it("opens a reused file again when the editor let go of it, and waits for the analysis again", async () => {
    const shadow = new ShadowSource({ fsPath: join(root, "storage-released") } as never, cache, output, wait);
    hoverAnswers.length = 0;
    hoverAnswers.push([{}]); // The first analysis succeeds.
    const first = (await shadow.sync(document(fixture, 1)))!;
    openDocuments.length = 0; // VS Code released the hidden document.
    hoverCalls = 0;
    hoverAnswers.length = 0;
    hoverAnswers.push([{}]);
    const second = (await shadow.sync(document(`// moved\n${fixture}`, 2)))!;
    expect(second.uri.fsPath).toBe(first.uri.fsPath);
    expect(openDocuments.some((d) => d.uri.fsPath === first.uri.fsPath)).toBe(true);
    expect(hoverCalls).toBe(1);
  });
});

describe.skipIf(process.platform === "win32")("ShadowSource when the generator fails", () => {
  const fileName = join(root, "failing", "acmeflat.driver");
  mkdirSync(join(root, "failing"), { recursive: true });
  writeFileSync(fileName, fixture);

  it("runs a failing generator once per version of the text, not on every request", async () => {
    const counter = join(root, "failing", "count");
    const script = join(root, "failing", "generator.sh");
    writeFileSync(script, `#!/bin/sh\necho run >> "${counter}"\necho 'ERROR (1:1): nope' >&2\nexit 1\n`);
    chmodSync(script, 0o755);
    const saved = process.env.INDIGO_GENERATOR;
    process.env.INDIGO_GENERATOR = script;
    try {
      const document = {
        fileName,
        version: 1,
        getText: () => fixture,
        uri: { scheme: "file", toString: () => `file://${fileName}` },
      } as never;
      const shadow = new ShadowSource(
        { fsPath: join(root, "storage-failing") } as never,
        { get: () => analyze(fixture) } as never,
        { appendLine: (): undefined => undefined } as never,
        { timeoutMs: 20, intervalMs: 5 },
      );
      expect(await shadow.sync(document)).toBeUndefined();
      expect(await shadow.sync(document)).toBeUndefined();
      expect(await shadow.sync(document)).toBeUndefined();
      expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(1);
      shadow.resetFailures();
      await shadow.sync(document);
      expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(2);
    } finally {
      process.env.INDIGO_GENERATOR = saved;
    }
  });
});
