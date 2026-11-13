import { describe, expect, it, vi } from "vitest";

import { analyze } from "../src/analysis";
import { type Node, walk } from "../src/parser";
import { buildShadowMap } from "../src/shadowMap";

const executed: { command: string; args: unknown[] }[] = [];
let answer: unknown;

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
  class Location {
    constructor(
      public uri: unknown,
      public range: Range,
    ) {}
  }
  class CompletionList {
    constructor(
      public items: unknown[],
      public isIncomplete: boolean,
    ) {}
  }
  class Hover {
    constructor(
      public contents: unknown[],
      public range?: Range,
    ) {}
  }
  return {
    Position,
    Range,
    Location,
    CompletionList,
    Hover,
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    extensions: { getExtension: () => ({ isActive: true, activate: async () => {} }) },
    commands: {
      executeCommand: async (command: string, ...args: unknown[]) => {
        executed.push({ command, args });
        return answer;
      },
    },
    workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
  };
});

const vscode = await import("vscode");
const { DriverCLanguageProvider } = await import("../src/cLanguage");
const { ShadowSource } = await import("../src/shadow");

const driver = `driver demo {
	code {
		static int twice(int x) {
			return x * 2;
		}
	}
}`;
const generated = `//+ code

static int twice(int x) {
	return x * 2;
}

//- code
`;

const notes: string[] = [];
const note = (_document: unknown, message: string) => notes.push(message);
const generatedUri = { toString: () => "file:///cache/indigo_aux_demo.c" };
const documentUri = { toString: () => "file:///work/demo.driver" };

function setup(enabled: boolean, editWhileWaiting = false) {
  const lines = driver.split("\n");
  const document = {
    uri: documentUri,
    version: 1,
    getText: () => driver,
    offsetAt: (p: { line: number; character: number }) =>
      lines.slice(0, p.line).reduce((sum, l) => sum + l.length + 1, 0) + p.character,
  };
  const { root } = analyze(driver);
  const nodes: Node[] = [];
  walk(root!, (n) => n.kind === "code" && nodes.push(n));
  const map = buildShadowMap(driver, nodes, generated);
  const cache = { get: () => analyze(driver) } as never;
  const shadow = {
    sync: async () => {
      if (editWhileWaiting) {
        document.version++; // The user typed while the generated copy was being made.
      }
      return { uri: generatedUri, map, version: 1, text: driver };
    },
    note,
  } as never;
  // The provider reads the setting through ShadowSource.isEnabled.
  vi.spyOn(ShadowSource, "isEnabled").mockReturnValue(enabled);
  return { document: document as never, provider: new DriverCLanguageProvider(cache, shadow) };
}

describe("DriverCLanguageProvider", () => {
  const inCode = () => new vscode.Position(3, 11); // inside "return x * 2;" in the driver
  const outside = () => new vscode.Position(0, 3);
  const token = {} as never;

  it("forwards completion to the generated file and maps ranges back", async () => {
    executed.length = 0;
    // The generated line has two tabs less than the driver line: column 8 there is column 10 here.
    answer = {
      items: [
        {
          label: "x",
          range: new vscode.Range(new vscode.Position(3, 8), new vscode.Position(3, 9)),
          additionalTextEdits: [{}],
        },
      ],
      isIncomplete: false,
    };
    const { document, provider } = setup(true);
    const list = (await provider.provideCompletionItems(document, inCode(), token, {
      triggerCharacter: undefined,
    } as never))!;
    expect(executed[0].command).toBe("vscode.executeCompletionItemProvider");
    expect((executed[0].args[0] as unknown) === generatedUri).toBe(true);
    const item = list.items[0] as {
      range: { start: { line: number; character: number } };
      additionalTextEdits?: unknown;
    };
    expect(item.range.start).toEqual({ line: 3, character: 10 });
    expect(item.additionalTextEdits).toBeUndefined();
  });

  it("does not answer for a text that changed while the generated copy was being made", async () => {
    executed.length = 0;
    answer = [{ contents: ["int x"] }];
    const { document, provider } = setup(true, true);
    expect(await provider.provideHover(document, inCode())).toBeUndefined();
    expect(executed).toEqual([]);
  });

  it("does not ask the C/C++ extension for a cancelled request", async () => {
    executed.length = 0;
    const { document, provider } = setup(true);
    const cancelled = { isCancellationRequested: true } as never;
    expect(await provider.provideHover(document, inCode(), cancelled)).toBeUndefined();
    expect(executed).toEqual([]);
  });

  it("leaves out definitions that lie in the generated file but outside the code blocks", async () => {
    answer = [
      new vscode.Location(
        generatedUri as never,
        new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 4)),
      ),
    ];
    const { document, provider } = setup(true);
    expect(await provider.provideDefinition(document, inCode())).toEqual([]);
  });

  it("says why nothing happens when the feature is off, but only inside code blocks", async () => {
    notes.length = 0;
    const off = setup(false);
    await off.provider.provideHover(off.document, outside());
    expect(notes).toEqual([]);
    await off.provider.provideHover(off.document, inCode());
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("indigoDriver.cLanguageFeatures");
  });

  it("does nothing outside code blocks or when the feature is off", async () => {
    executed.length = 0;
    const on = setup(true);
    expect(await on.provider.provideHover(on.document, outside())).toBeUndefined();
    const off = setup(false);
    expect(await off.provider.provideHover(off.document, inCode())).toBeUndefined();
    expect(executed).toEqual([]);
  });

  it("sends definitions in the generated code blocks back to the driver and leaves other files alone", async () => {
    const header = { toString: () => "file:///usr/include/indigo/indigo_bus.h" };
    answer = [
      new vscode.Location(
        generatedUri as never,
        new vscode.Range(new vscode.Position(2, 12), new vscode.Position(2, 17)),
      ),
      new vscode.Location(header as never, new vscode.Range(new vscode.Position(10, 0), new vscode.Position(10, 4))),
    ];
    const { document, provider } = setup(true);
    const links = (await provider.provideDefinition(document, inCode()))!;
    expect(links[0].targetUri).toBe(documentUri);
    expect(links[0].targetRange.start).toEqual({ line: 2, character: 14 });
    expect(links[1].targetUri).toBe(header);
  });

  it("merges hover contents", async () => {
    answer = [
      { contents: ["int x"], range: undefined },
      { contents: ["parameter"], range: undefined },
    ];
    const { document, provider } = setup(true);
    const hover = (await provider.provideHover(document, inCode()))!;
    expect(hover.contents).toEqual(["int x", "parameter"]);
  });
});
