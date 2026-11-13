import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import * as vscode from "vscode";

import { generatedSourceName } from "./analysis";
import { generatorErrorLine, parseGeneratorErrors } from "./generatorOutput";
import {
  AnalysisCache,
  DriverCompletionProvider,
  DriverDiagnostics,
  DriverFoldingProvider,
  DriverHoverProvider,
  DriverSymbolProvider,
  LANGUAGE_ID,
} from "./providers";

/** Runs indigo_generator on a .driver file and reports its errors as diagnostics. */
class GeneratorRunner implements vscode.Disposable {
  #diagnostics = vscode.languages.createDiagnosticCollection("indigo_generator");
  #output = vscode.window.createOutputChannel("INDIGO Driver");
  #running = new Set<string>();

  constructor(private readonly cache: AnalysisCache) {}

  clear(document: vscode.TextDocument) {
    this.#diagnostics.delete(document.uri);
  }

  /** Runs the generator once per file at a time: saving a dirty file inside `run` would otherwise start a second run. */
  async run(document: vscode.TextDocument, quiet = false) {
    if (!vscode.workspace.isTrusted) {
      vscode.window.showWarningMessage("indigo_generator is not run in untrusted workspaces.");
      return;
    }
    if (document.uri.scheme !== "file") {
      vscode.window.showWarningMessage("indigo_generator can only run on files saved on disk.");
      return;
    }
    const key = document.uri.toString();
    if (this.#running.has(key)) {
      return;
    }
    this.#running.add(key);
    try {
      await this.#execute(document, quiet);
    } finally {
      this.#running.delete(key);
    }
  }

  async #execute(document: vscode.TextDocument, quiet: boolean) {
    if (document.isDirty && !(await document.save())) {
      return;
    }
    const version = document.version;
    const configured = vscode.workspace.getConfiguration("indigoDriver", document.uri).get<string>("generatorPath", "");
    const executable = configured.trim() || "indigo_generator";
    this.#output.appendLine(`$ ${executable} ${document.fileName}`);
    const { code, output, missing } = await new Promise<{ code: number; output: string; missing: boolean }>(
      (resolve) => {
        execFile(executable, [document.fileName], { cwd: dirname(document.fileName) }, (error, stdout, stderr) => {
          const failure = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
          const text = `${stdout}${stderr}`;
          resolve({
            code: failure ? (typeof failure.code === "number" ? failure.code : 1) : 0,
            output: failure && text.trim() === "" ? failure.message : text,
            missing: failure?.code === "ENOENT",
          });
        });
      },
    );
    this.#output.appendLine(output.trimEnd());
    if (missing) {
      const choice = await vscode.window.showErrorMessage(
        `Cannot run '${executable}'. Build indigo_generator and set 'indigoDriver.generatorPath'.`,
        "Open Settings",
      );
      if (choice) {
        vscode.commands.executeCommand("workbench.action.openSettings", "indigoDriver.generatorPath");
      }
      return;
    }
    const errors = parseGeneratorErrors(output);
    // Line numbers refer to the saved text: drop them if the user kept typing meanwhile.
    if (document.version === version) {
      this.#diagnostics.set(
        document.uri,
        errors.map((error) => {
          const line = Math.min(generatorErrorLine(error), document.lineCount - 1);
          const diagnostic = new vscode.Diagnostic(
            document.lineAt(line).range,
            error.message,
            vscode.DiagnosticSeverity.Error,
          );
          diagnostic.source = "indigo_generator";
          return diagnostic;
        }),
      );
    }
    if (code !== 0 || errors.length > 0) {
      this.#output.show(true);
      vscode.window.showErrorMessage(`indigo_generator failed on ${basename(document.fileName)}.`);
      return;
    }
    if (!quiet) {
      const choice = await vscode.window.showInformationMessage("C sources generated.", "Open C Source");
      if (choice) {
        await this.openGenerated(document);
      }
    }
  }

  async openGenerated(document: vscode.TextDocument) {
    const { root } = this.cache.get(document);
    const name = root && generatedSourceName(root);
    if (!name) {
      vscode.window.showWarningMessage(
        "The driver needs a name and at least one device block to derive the C file name.",
      );
      return;
    }
    const path = join(dirname(document.fileName), name);
    if (!existsSync(path)) {
      vscode.window.showWarningMessage(`${name} does not exist yet: run 'INDIGO Driver: Generate C Sources' first.`);
      return;
    }
    await vscode.window.showTextDocument(vscode.Uri.file(path));
  }

  dispose() {
    this.#diagnostics.dispose();
    this.#output.dispose();
  }
}

export function activate(context: vscode.ExtensionContext) {
  const cache = new AnalysisCache();
  const diagnostics = new DriverDiagnostics(cache);
  const runner = new GeneratorRunner(cache);
  const selector: vscode.DocumentSelector = { language: LANGUAGE_ID };

  const activeDriver = () => {
    const document = vscode.window.activeTextEditor?.document;
    if (document?.languageId !== LANGUAGE_ID) {
      vscode.window.showWarningMessage("Open a .driver file first.");
      return undefined;
    }
    return document;
  };

  context.subscriptions.push(
    diagnostics,
    runner,
    vscode.languages.registerDocumentSymbolProvider(selector, new DriverSymbolProvider(cache)),
    vscode.languages.registerFoldingRangeProvider(selector, new DriverFoldingProvider(cache)),
    vscode.languages.registerCompletionItemProvider(selector, new DriverCompletionProvider(cache)),
    vscode.languages.registerHoverProvider(selector, new DriverHoverProvider(cache)),
    vscode.commands.registerCommand("indigoDriver.generate", () => {
      const document = activeDriver();
      return document ? runner.run(document) : undefined;
    }),
    vscode.commands.registerCommand("indigoDriver.openGenerated", () => {
      const document = activeDriver();
      return document ? runner.openGenerated(document) : undefined;
    }),
    vscode.workspace.onDidOpenTextDocument((document) => diagnostics.refresh(document)),
    vscode.workspace.onDidChangeTextDocument(({ document }) => {
      diagnostics.schedule(document);
      runner.clear(document);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      diagnostics.clear(document);
      runner.clear(document);
      cache.delete(document);
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      const enabled = vscode.workspace
        .getConfiguration("indigoDriver", document.uri)
        .get<boolean>("generateOnSave", false);
      if (enabled && document.languageId === LANGUAGE_ID) {
        void runner.run(document, true);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("indigoDriver.lint.enable")) {
        vscode.workspace.textDocuments.forEach((document) => diagnostics.refresh(document));
      }
    }),
  );
  vscode.workspace.textDocuments.forEach((document) => diagnostics.refresh(document));
}

export function deactivate() {}
