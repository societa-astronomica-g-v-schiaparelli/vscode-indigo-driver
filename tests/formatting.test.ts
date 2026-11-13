import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { analyze } from "../src/analysis";
import { DEFAULT_CLANG_FORMAT } from "../src/formatCode";
import { naiveFormat } from "./helpers";

const state = {
  /** What the C/C++ formatter answers for a scratch text; undefined means no answer yet. */
  formatter: (scratch: string): string | undefined => naiveFormat(scratch),
  asked: 0,
  installed: true,
  activated: 0,
  warnings: [] as string[],
  statusMessages: 0,
  opened: [] as string[],
};

vi.mock("vscode", () => {
  class Position {
    constructor(
      public line: number,
      public character: number,
    ) {}
  }
  class Range {
    constructor(
      public start: Position,
      public end: Position,
    ) {}
  }
  // Hidden documents by path. Like the real thing a document loads from disk once; nothing here can edit or save it.
  const texts = new Map<string, string>();
  const model = (path: string) => {
    const text = texts.get(path) ?? "";
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") {
        starts.push(i + 1);
      }
    }
    return {
      getText: () => text,
      offsetAt: (p: Position) => starts[p.line] + p.character,
      positionAt: (offset: number) => {
        let line = starts.length - 1;
        while (starts[line] > offset) {
          line--;
        }
        return new Position(line, offset - starts[line]);
      },
    };
  };
  return {
    Position,
    Range,
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    TextEdit: { replace: (range: Range, newText: string) => ({ range, newText }) },
    Uri: { file: (path: string) => ({ fsPath: path, scheme: "file", toString: () => `file://${path}` }) },
    extensions: {
      getExtension: () =>
        state.installed
          ? {
              isActive: false,
              activate: async () => {
                state.activated++;
              },
            }
          : undefined,
    },
    workspace: {
      openTextDocument: async (uri: { fsPath: string }) => {
        const { readFileSync } = await import("node:fs");
        state.opened.push(uri.fsPath);
        if (!texts.has(uri.fsPath)) {
          texts.set(uri.fsPath, readFileSync(uri.fsPath, "utf8"));
        }
        return model(uri.fsPath);
      },
    },
    window: {
      setStatusBarMessage: () => {
        state.statusMessages++;
      },
      showWarningMessage: (message: string) => {
        state.warnings.push(message);
      },
    },
    commands: {
      executeCommand: async (command: string, uri: { fsPath: string }) => {
        if (command !== "vscode.executeFormatDocumentProvider") {
          throw new Error(command);
        }
        state.asked++;
        const buffer = model(uri.fsPath);
        const formatted = state.formatter(buffer.getText());
        if (formatted === undefined) {
          return undefined;
        }
        const length = buffer.getText().length;
        return [{ range: new Range(buffer.positionAt(0), buffer.positionAt(length)), newText: formatted }];
      },
    },
  };
});

const vscode = await import("vscode");
const { DriverFormattingProvider } = await import("../src/formatting");

const root = mkdtempSync(join(tmpdir(), "indigo-format-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  state.formatter = naiveFormat;
  state.asked = 0;
  state.installed = true;
  state.activated = 0;
  state.warnings = [];
  state.statusMessages = 0;
  state.opened = [];
});

const messy = `driver d {
	wheel {
		on_connect {
foo();
		}
		on_disconnect {
bar();
		}
	}
}`;

const options = { tabSize: 2, insertSpaces: false } as never;

function setup(text: string, directory = join(root, "project")) {
  mkdirSync(directory, { recursive: true });
  const fileName = join(directory, "x.driver");
  const offsets: number[] = [];
  let sum = 0;
  for (const line of text.split("\n")) {
    offsets.push(sum);
    sum += line.length + 1;
  }
  const positionAt = (offset: number) => {
    let line = offsets.length - 1;
    while (offsets[line] > offset) {
      line--;
    }
    return new vscode.Position(line, offset - offsets[line]);
  };
  const document = {
    fileName,
    uri: { scheme: "file", toString: () => `file://${fileName}` },
    version: 1,
    getText: () => text,
    offsetAt: (p: { line: number; character: number }) => offsets[p.line] + p.character,
    positionAt,
  };
  const provider = new DriverFormattingProvider(
    { get: () => analyze(text) } as never,
    { fsPath: join(root, "storage") } as never,
    { attempts: 3, delayMs: 0 },
  );
  return { document: document as never, provider, positionAt };
}

function apply(text: string, edits: { range: { start: unknown; end: unknown }; newText: string }[], document: never) {
  const d = document as { offsetAt(p: unknown): number };
  return [...edits]
    .sort((a, b) => d.offsetAt(b.range.start) - d.offsetAt(a.range.start))
    .reduce((acc, e) => acc.slice(0, d.offsetAt(e.range.start)) + e.newText + acc.slice(d.offsetAt(e.range.end)), text);
}

async function formatted(text: string) {
  const { document, provider } = setup(text);
  return apply(text, (await provider.provideDocumentFormattingEdits(document, options)) as never, document);
}

describe("DriverFormattingProvider", () => {
  it("formats every code block of the document", async () => {
    expect(await formatted(messy)).toBe(
      messy.replace("\nfoo();", "\n\t\t\tfoo();").replace("\nbar();", "\n\t\t\tbar();"),
    );
  });

  it("formats only the blocks touched by the range", async () => {
    const { document, provider, positionAt } = setup(messy);
    const range = new vscode.Range(positionAt(messy.indexOf("bar")), positionAt(messy.indexOf("bar") + 3));
    const edits = await provider.provideDocumentRangeFormattingEdits(document, range, options);
    expect(apply(messy, edits as never, document)).toBe(messy.replace("\nbar();", "\n\t\t\tbar();"));
  });

  it("returns no edits when the code is already formatted", async () => {
    const once = await formatted(messy);
    const again = setup(once);
    expect(await again.provider.provideDocumentFormattingEdits(again.document, options)).toEqual([]);
  });

  it("refuses to format a definition with syntax errors", async () => {
    const broken = "driver d {\n\twheel {\n\t\ton_connect {\nfoo();\n";
    const { document, provider } = setup(broken);
    expect(await provider.provideDocumentFormattingEdits(document, options)).toEqual([]);
    expect(state.statusMessages).toBe(1);
    expect(state.asked).toBe(0);
  });

  it("uses the .clang-format of the project, or the built-in one", async () => {
    const project = join(root, "styled");
    mkdirSync(join(project, "deep", "er"), { recursive: true });
    writeFileSync(join(project, ".clang-format"), "BasedOnStyle: Google\n");
    const styled = setup(messy, join(project, "deep", "er"));
    await styled.provider.provideDocumentFormattingEdits(styled.document, options);
    const read = () =>
      readdirSync(join(root, "storage", "format")).map((d) =>
        readFileSync(join(root, "storage", "format", d, ".clang-format"), "utf8"),
      );
    expect(read()).toContain("BasedOnStyle: Google\n");
    const plain = setup(messy, join(root, "plain"));
    await plain.provider.provideDocumentFormattingEdits(plain.document, options);
    expect(read()).toContain(DEFAULT_CLANG_FORMAT);
  });

  it("wakes up the C/C++ extension before asking, and keeps asking until it answers", async () => {
    const answers = [undefined, undefined, naiveFormat];
    state.formatter = (scratch) => answers.shift()?.(scratch);
    expect(await formatted(messy)).toContain("\t\t\tfoo();");
    expect(state.activated).toBe(1);
    expect(state.asked).toBe(3);
    expect(state.warnings).toEqual([]);
  });

  it("never edits or saves anything through the editor, and removes its scratch file", async () => {
    // The mock has no applyEdit and no save: using either would throw.
    await formatted(messy);
    await formatted(messy.replace("foo", "baz"));
    const dir = join(root, "storage", "format");
    const leftovers = readdirSync(dir).flatMap((d) => readdirSync(join(dir, d)).filter((f) => f.startsWith("scratch")));
    expect(leftovers).toEqual([]);
  });

  it("uses a new scratch file for every run", async () => {
    await formatted(messy);
    await formatted(messy);
    const scratches = state.opened.filter((path) => /scratch-.*\.c$/.test(path));
    expect(new Set(scratches).size).toBe(2);
  });

  it("does not apply a result to a text that changed while the formatter was working", async () => {
    const { document, provider } = setup(messy);
    state.formatter = (scratch) => {
      (document as { version: number }).version++;
      return naiveFormat(scratch);
    };
    expect(await provider.provideDocumentFormattingEdits(document, options)).toEqual([]);
  });

  it("asks only once per format after a failure, so a setup without a formatter is not slowed down", async () => {
    state.formatter = () => undefined;
    const { document, provider } = setup(messy);
    await provider.provideDocumentFormattingEdits(document, options);
    expect(state.asked).toBe(3);
    await provider.provideDocumentFormattingEdits(document, options);
    expect(state.asked).toBe(4);
    state.formatter = naiveFormat;
    await provider.provideDocumentFormattingEdits(document, options);
    expect(state.asked).toBe(5);
    state.formatter = () => undefined;
    await provider.provideDocumentFormattingEdits(document, options);
    expect(state.asked).toBe(8); // A success earns the full number of attempts again.
  });

  it("does no work at all when the C/C++ extension is missing", async () => {
    state.installed = false;
    const { document, provider } = setup(messy);
    expect(await provider.provideDocumentFormattingEdits(document, options)).toEqual([]);
    expect(state.asked).toBe(0);
    expect(state.opened).toEqual([]);
  });

  it("warns once, and says what is wrong, when the formatter never answers", async () => {
    state.formatter = () => undefined;
    const { document, provider } = setup(messy);
    expect(await provider.provideDocumentFormattingEdits(document, options)).toEqual([]);
    expect(await provider.provideDocumentFormattingEdits(document, options)).toEqual([]);
    expect(state.warnings).toHaveLength(1);
    expect(state.warnings[0]).toContain("did not answer");
  });

  it("asks to install the C/C++ extension only when it is missing", async () => {
    state.installed = false;
    state.formatter = () => undefined;
    const { document, provider } = setup(messy);
    await provider.provideDocumentFormattingEdits(document, options);
    expect(state.warnings[0]).toContain("install the C/C++ extension");
    expect(state.activated).toBe(0);
  });
});
