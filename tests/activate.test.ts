import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

const registered: string[] = [];
const cleanups: string[] = [];

vi.mock("../src/cleanup", () => ({
  cleanStorage: async (path: string) => {
    cleanups.push(path);
    return 0;
  },
}));
vi.mock("vscode-cpptools", () => ({ Version: { v5: 5 }, getCppToolsApi: async (): Promise<undefined> => undefined }));
vi.mock("vscode", () => {
  const disposable = () => ({ dispose: (): undefined => undefined });
  const event = () => disposable();
  return {
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    SymbolKind: {},
    CompletionItemKind: {},
    ConfigurationTarget: {},
    extensions: { getExtension: (): undefined => undefined },
    window: {
      createOutputChannel: () => ({ appendLine: (): undefined => undefined, dispose: (): undefined => undefined }),
      activeTextEditor: undefined,
      showWarningMessage: (): undefined => undefined,
    },
    languages: {
      createDiagnosticCollection: () => ({
        set: (): undefined => undefined,
        delete: (): undefined => undefined,
        dispose: (): undefined => undefined,
      }),
      registerDocumentSymbolProvider: disposable,
      registerFoldingRangeProvider: disposable,
      registerCompletionItemProvider: disposable,
      registerHoverProvider: disposable,
      registerDefinitionProvider: disposable,
      registerSignatureHelpProvider: disposable,
      registerDocumentFormattingEditProvider: disposable,
      registerDocumentRangeFormattingEditProvider: disposable,
    },
    commands: {
      registerCommand: (id: string) => {
        registered.push(id);
        return disposable();
      },
    },
    workspace: {
      isTrusted: true,
      textDocuments: [],
      getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
      onDidOpenTextDocument: event,
      onDidChangeTextDocument: event,
      onDidCloseTextDocument: event,
      onDidSaveTextDocument: event,
      onDidChangeConfiguration: event,
    },
  };
});

const { activate } = await import("../src/extension");

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("activate", () => {
  const context = {
    subscriptions: [] as unknown[],
    globalStorageUri: { fsPath: "/storage/indigo-driver" },
    globalState: { get: (): undefined => undefined, update: async (): Promise<void> => undefined },
    extension: { id: "publisher.indigo-driver" },
  };
  activate(context as never);

  it("cleans the storage folder when the extension starts", () => {
    expect(cleanups).toEqual(["/storage/indigo-driver"]);
  });

  it("registers every command that the manifest contributes", () => {
    const contributed = manifest.contributes.commands.map((command: { command: string }) => command.command);
    expect(contributed.length).toBeGreaterThan(0);
    expect([...registered].sort()).toEqual([...contributed].sort());
  });

  it("keeps everything it creates in the subscriptions, to be disposed with the extension", () => {
    expect(context.subscriptions.length).toBeGreaterThan(10);
  });
});
