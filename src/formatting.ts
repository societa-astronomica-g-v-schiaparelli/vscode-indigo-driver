import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, parse as parsePath } from "node:path";

import * as vscode from "vscode";

import { buildScratch, DEFAULT_CLANG_FORMAT, formattedReplacements } from "./formatCode";
import { activateCppTools, openScratch, removeScratch, withTimeout } from "./modelFile";
import { type Node, walk } from "./parser";
import type { AnalysisCache } from "./providers";

/** The nearest .clang-format above a directory, as clang-format itself would look for it. */
function findClangFormat(directory: string): string | undefined {
  for (let current = directory; ; current = dirname(current)) {
    for (const name of [".clang-format", "_clang-format"]) {
      if (existsSync(join(current, name))) {
        return join(current, name);
      }
    }
    if (current === parsePath(current).root) {
      return undefined;
    }
  }
}

function applyEdits(model: vscode.TextDocument, edits: vscode.TextEdit[]): string {
  let text = model.getText();
  const ordered = [...edits].sort((a, b) => model.offsetAt(b.range.start) - model.offsetAt(a.range.start));
  for (const edit of ordered) {
    text = text.slice(0, model.offsetAt(edit.range.start)) + edit.newText + text.slice(model.offsetAt(edit.range.end));
  }
  return text;
}

/**
 * Formats the C code blocks of a .driver file with the C/C++ formatter of the editor (clang-format in Microsoft
 * C/C++). The structure of the definition itself is left alone.
 */
export class DriverFormattingProvider
  implements vscode.DocumentFormattingEditProvider, vscode.DocumentRangeFormattingEditProvider
{
  #queue: Promise<unknown> = Promise.resolve();
  #warned = false;
  #failedBefore = false;

  constructor(
    private readonly cache: AnalysisCache,
    private readonly storage: vscode.Uri,
    private readonly retry: { attempts: number; delayMs: number; callTimeoutMs?: number } = {
      attempts: 10,
      delayMs: 700,
      callTimeoutMs: 5000,
    },
  ) {}

  provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
    token?: vscode.CancellationToken,
  ): Promise<vscode.TextEdit[]> {
    return this.#enqueue(document, options, undefined, token);
  }

  provideDocumentRangeFormattingEdits(
    document: vscode.TextDocument,
    range: vscode.Range,
    options: vscode.FormattingOptions,
    token?: vscode.CancellationToken,
  ): Promise<vscode.TextEdit[]> {
    return this.#enqueue(document, options, range, token);
  }

  /** Formatting calls share one scratch file per driver, so they run one after the other. */
  #enqueue(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
    range?: vscode.Range,
    token?: vscode.CancellationToken,
  ) {
    const run = this.#queue.then((): vscode.TextEdit[] | Promise<vscode.TextEdit[]> =>
      token?.isCancellationRequested ? [] : this.#format(document, options, range),
    );
    this.#queue = run.catch((): undefined => undefined);
    return run;
  }

  async #format(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
    range?: vscode.Range,
  ): Promise<vscode.TextEdit[]> {
    const version = document.version;
    const analysis = this.cache.get(document);
    if (!analysis.root || analysis.syntax.some((problem) => problem.severity === "error")) {
      vscode.window.setStatusBarMessage("INDIGO Driver: fix the syntax errors before formatting", 4000);
      return [];
    }
    const text = document.getText();
    const from = range ? document.offsetAt(range.start) : 0;
    const to = range ? document.offsetAt(range.end) : text.length;
    const nodes: Node[] = [];
    walk(analysis.root, (node) => {
      const blank = text.slice(node.bodyStart, node.bodyEnd).trim() === "";
      if (node.kind === "code" && !blank && node.bodyStart <= to && node.bodyEnd >= from) {
        nodes.push(node);
      }
    });
    if (nodes.length === 0) {
      return [];
    }
    const installed = await activateCppTools();
    if (!installed) {
      this.#warnOnce(false);
      return [];
    }
    const blocks = nodes.map((node) => ({ keyword: node.keyword, code: text.slice(node.bodyStart, node.bodyEnd) }));
    const scratch = buildScratch(blocks);
    const cpp = analysis.root.children.some((c) => c.kind === "attribute" && c.keyword === "cpp" && c.value === "true");
    const dir = join(
      this.storage.fsPath,
      "format",
      createHash("sha1").update(document.fileName).digest("hex").slice(0, 12),
    );
    await mkdir(dir, { recursive: true });
    const style = document.uri.scheme === "file" ? findClangFormat(dirname(document.fileName)) : undefined;
    if (style) {
      await copyFile(style, join(dir, ".clang-format"));
    } else {
      await writeFile(join(dir, ".clang-format"), DEFAULT_CLANG_FORMAT);
    }
    const file = await openScratch(dir, "scratch", cpp ? ".cpp" : ".c", scratch);
    let edits: vscode.TextEdit[] | undefined;
    let model: vscode.TextDocument;
    try {
      model = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      edits = await this.#askFormatter(vscode.Uri.file(file), options);
    } finally {
      await removeScratch(file);
    }
    if (!edits) {
      this.#warnOnce(true);
      return [];
    }
    // The text was read before the formatter ran, which can take a while: do not apply it to a newer text.
    if (document.version !== version) {
      return [];
    }
    return formattedReplacements(text, nodes, applyEdits(model, edits), options.tabSize, options.insertSpaces).map(
      (replacement) =>
        vscode.TextEdit.replace(
          new vscode.Range(document.positionAt(replacement.start), document.positionAt(replacement.end)),
          replacement.text,
        ),
    );
  }

  /**
   * The scratch file always needs edits (its probe sits at column 0), so an empty answer means the formatter is not
   * ready yet, as happens right after the C/C++ extension starts: ask again for a while.
   */
  async #askFormatter(uri: vscode.Uri, options: vscode.FormattingOptions): Promise<vscode.TextEdit[] | undefined> {
    // After a failure just ask once: waiting again would only stall every format of a setup without a formatter.
    const attempts = this.#failedBefore ? 1 : this.retry.attempts;
    const ask = async () => {
      for (let attempt = 0; attempt < attempts; attempt++) {
        const edits = await withTimeout(
          vscode.commands.executeCommand<vscode.TextEdit[] | undefined>("vscode.executeFormatDocumentProvider", uri, {
            tabSize: options.tabSize,
            insertSpaces: options.insertSpaces,
          }),
          this.retry.callTimeoutMs ?? 5000,
        );
        if (edits && edits.length > 0) {
          return edits;
        }
        if (attempt < attempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, this.retry.delayMs));
        }
      }
      return undefined;
    };
    const pending = ask();
    vscode.window.setStatusBarMessage("INDIGO Driver: formatting the code blocks...", pending);
    const edits = await pending;
    this.#failedBefore = edits === undefined;
    return edits;
  }

  #warnOnce(installed: boolean) {
    if (!this.#warned) {
      this.#warned = true;
      vscode.window.showWarningMessage(
        installed
          ? "The C/C++ formatter did not answer. Check that formatting is enabled in the C/C++ extension (C_Cpp.formatting) and try again."
          : "Formatting the code blocks needs a C/C++ formatter: install the C/C++ extension (ms-vscode.cpptools).",
      );
    }
  }
}
