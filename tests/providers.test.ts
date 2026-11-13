import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

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
  class DocumentSymbol {
    children: DocumentSymbol[] = [];
    constructor(
      public name: string,
      public detail: string,
      public kind: number,
      public range: Range,
      public selectionRange: Range,
    ) {
      // Same check as the real class.
      const before = (a: Position, b: Position) => a.line < b.line || (a.line === b.line && a.character <= b.character);
      if (!before(range.start, selectionRange.start) || !before(selectionRange.end, range.end)) {
        throw new Error("selectionRange must be contained in fullRange");
      }
    }
  }
  class CompletionItem {
    detail?: string;
    documentation?: unknown;
    insertText?: unknown;
    constructor(
      public label: string,
      public kind: number,
    ) {}
  }
  class SnippetString {
    constructor(public value: string) {}
  }
  class MarkdownString {
    constructor(public value: string) {}
  }
  class Hover {
    constructor(
      public contents: MarkdownString,
      public range: Range,
    ) {}
  }
  class FoldingRange {
    constructor(
      public start: number,
      public end: number,
    ) {}
  }
  class Diagnostic {
    source?: string;
    constructor(
      public range: Range,
      public message: string,
      public severity: number,
    ) {}
  }
  const collections: Record<string, Map<string, unknown>> = {};
  return {
    Position,
    Range,
    DocumentSymbol,
    CompletionItem,
    SnippetString,
    MarkdownString,
    Hover,
    FoldingRange,
    Diagnostic,
    SymbolKind: { Module: 1, Class: 2, Property: 3, Field: 4, Interface: 5, Function: 6, Event: 7 },
    CompletionItemKind: { Property: 1, Function: 2, Interface: 3, Class: 4, EnumMember: 5 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    languages: {
      createDiagnosticCollection: (name: string) => {
        const map = (collections[name] = new Map());
        return {
          set: (uri: { toString(): string }, value: unknown) => map.set(uri.toString(), value),
          delete: (uri: { toString(): string }) => map.delete(uri.toString()),
          dispose: () => map.clear(),
        };
      },
    },
    workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
    __collections: collections,
  };
});

const vscode = await import("vscode");
const {
  AnalysisCache,
  DriverCompletionProvider,
  DriverDiagnostics,
  DriverFoldingProvider,
  DriverHoverProvider,
  DriverSymbolProvider,
} = await import("../src/providers");

const fixture = readFileSync(new URL("./fixtures/acmeflat.driver", import.meta.url), "utf8");

let documentCount = 0;

function fakeDocument(text: string, version = 1) {
  const uri = `file:///fake-${documentCount++}.driver`;
  const lines = text.split("\n");
  const offsets: number[] = [];
  let sum = 0;
  for (const line of lines) {
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
  return {
    languageId: "indigo-driver",
    uri: { toString: () => uri },
    version,
    getText: () => text,
    positionAt,
    offsetAt: (p: { line: number; character: number }) => offsets[p.line] + p.character,
    lineAt: (line: number) => ({ text: lines[line] }),
  } as never;
}

const at = (text: string, marker: string, delta = 0) => {
  const document = fakeDocument(text) as { positionAt(offset: number): unknown };
  return document.positionAt(text.indexOf(marker) + delta) as never;
};

// The fake Hover keeps a single MarkdownString, the real type allows several.
const hoverText = (hover: { contents: unknown } | undefined) =>
  (hover?.contents as { value: string } | undefined)?.value;

describe("providers", () => {
  const cache = new AnalysisCache();

  it("builds the outline", () => {
    const [driver] = new DriverSymbolProvider(cache).provideDocumentSymbols(fakeDocument(fixture));
    expect(driver.name).toBe("driver acmeflat");
    const names = driver.children.map((c) => c.name);
    expect(names).toContain("serial");
    expect(names).toContain('aux "ACME Flat Panel"');
    const aux = driver.children.find((c) => c.name.startsWith("aux"))!;
    expect(aux.children.map((c) => c.name)).toEqual(
      expect.arrayContaining(["on_connect", "switch AUX_LIGHT_SWITCH", "number AUX_LIGHT_INTENSITY", "text X_INFO"]),
    );
    const switchSymbol = aux.children.find((c) => c.name === "switch AUX_LIGHT_SWITCH")!;
    expect(switchSymbol.children.map((c) => c.name)).toContain("item AUX_LIGHT_SWITCH_ON");
  });

  it("keeps the outline while the driver name is being typed", () => {
    const [driver] = new DriverSymbolProvider(cache).provideDocumentSymbols(fakeDocument("driver foo"));
    expect(driver.name).toBe("driver foo");
  });

  it("folds blocks that span several lines", () => {
    const ranges = new DriverFoldingProvider(cache).provideFoldingRanges(fakeDocument(fixture));
    expect(ranges.length).toBeGreaterThan(10);
    expect(ranges.every((r) => r.end > r.start)).toBe(true);
    expect(ranges.some((r) => r.start === 2)).toBe(true);
  });

  it("completes attributes and blocks inside a device, skipping present attributes", () => {
    const text = 'driver d {\n\twheel {\n\t\tname = "w";\n\t\t\n\t}\n}';
    const items = new DriverCompletionProvider(cache).provideCompletionItems(
      fakeDocument(text),
      new vscode.Position(3, 2) as never,
    );
    const labels = items.map((i) => i.label);
    expect(labels).toContain("additional_instances");
    expect(labels).not.toContain("name");
    expect(labels).toEqual(expect.arrayContaining(["on_connect", "switch", "inherited"]));
    expect(labels).not.toContain("serial");
  });

  it("completes values for permission attributes", () => {
    const text = "driver d {\n\twheel {\n\t\tinherited WHEEL_SLOT {\n\t\t\tperm = ;\n\t\t}\n\t}\n}";
    const items = new DriverCompletionProvider(cache).provideCompletionItems(
      fakeDocument(text),
      new vscode.Position(3, 10) as never,
    );
    expect(items.map((i) => i.label)).toEqual(["INDIGO_RW_PERM", "INDIGO_RO_PERM", "INDIGO_WO_PERM"]);
  });

  it("offers nothing inside code blocks or comments", () => {
    const provider = new DriverCompletionProvider(cache);
    const document = fakeDocument(fixture);
    expect(provider.provideCompletionItems(document, at(fixture, "static bool acmeflat_command", 7))).toEqual([]);
    const commented = "driver d {\n\t// a comm\n}";
    expect(provider.provideCompletionItems(fakeDocument(commented), new vscode.Position(1, 8) as never)).toEqual([]);
  });

  it("documents attributes and blocks on hover", () => {
    const provider = new DriverHoverProvider(cache);
    const document = fakeDocument(fixture);
    const attribute = provider.provideHover(document, at(fixture, "interface = ", 3));
    expect(hoverText(attribute)).toContain("INDIGO_INTERFACE_AUX_*");
    const block = provider.provideHover(document, at(fixture, "on_connect", 2));
    expect(hoverText(block)).toContain("connection_result");
    expect(provider.provideHover(document, at(fixture, "PRIVATE_DATA->handle = ", 3))).toBeUndefined();
  });

  it("publishes diagnostics with converted ranges", () => {
    const diagnostics = new DriverDiagnostics(new AnalysisCache());
    const document = fakeDocument('driver d {\n\taux { name = "x" }\n}');
    diagnostics.refresh(document);
    const published = (vscode as unknown as { __collections: Record<string, Map<string, unknown[]>> }).__collections[
      "indigo-driver"
    ].get((document as { uri: { toString(): string } }).uri.toString()) as {
      message: string;
      range: { start: { line: number } };
    }[];
    expect(published.map((d) => d.message)).toContain("Missing ';' after the value of 'name'");
    expect(published.find((d) => d.message.startsWith("Missing ';'"))?.range.start.line).toBe(1);
    diagnostics.dispose();
  });
});
