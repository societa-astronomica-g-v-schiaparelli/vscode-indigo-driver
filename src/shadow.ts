import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import * as vscode from "vscode";

import { generatedSourceName } from "./analysis";
import { runGenerator } from "./generate";
import { activateCppTools, openScratch, removeScratch, touch, withTimeout } from "./modelFile";
import { type Node, walk } from "./parser";
import type { AnalysisCache } from "./providers";
import { buildShadowMap, type ShadowMap } from "./shadowMap";

interface Published {
  generated: string;
  path: string;
}

export interface ShadowState {
  /** The generated C source, which the C/C++ extension analyzes. */
  uri: vscode.Uri;
  map: ShadowMap;
  /** The version and the text of the .driver document that the map belongs to. */
  version: number;
  text: string;
}

export interface WaitOptions {
  timeoutMs: number;
  intervalMs: number;
}

/** How long the C features stop waiting for the C/C++ extension after it failed to answer. */
const SKIP_WAIT_MS = 5 * 60 * 1000;

/** A symbol defined in the generated file that the C/C++ extension can answer for once it analyzed the file. */
export function findProbe(generated: string): { line: number; col: number } | undefined {
  const match = /^indigo_result\s+(indigo_\w+)\s*\(/m.exec(generated) ?? /^#define\s+(DRIVER_NAME)\b/m.exec(generated);
  if (!match) {
    return undefined;
  }
  const offset = match.index + match[0].indexOf(match[1]);
  const before = generated.slice(0, offset).split("\n");
  return { line: before.length - 1, col: before[before.length - 1].length };
}

/**
 * Keeps a generated C file for each .driver document, in the extension storage, so that the C/C++ extension can
 * answer for the code blocks. The file is regenerated whenever the document changed since the last request.
 * Requests for one document run one after the other: they share the generator folder and the published file.
 */
export class ShadowSource {
  #states = new Map<string, ShadowState>();
  #pending = new Map<string, { version: number; text: string; promise: Promise<ShadowState | undefined> }>();
  #chains = new Map<string, Promise<unknown>>();
  #failed = new Map<string, { version: number; text: string }>();
  #published = new Map<string, Published>();
  #origins = new Map<string, string>();
  #warned = false;
  #noted = new Set<string>();
  #skipWaitUntil = 0;

  constructor(
    private readonly storage: vscode.Uri,
    private readonly cache: AnalysisCache,
    private readonly output: vscode.OutputChannel,
    private readonly wait: WaitOptions = { timeoutMs: 15000, intervalMs: 300 },
  ) {}

  /** Say in the output channel why the C features do nothing, once per reason and file. */
  note(document: vscode.TextDocument, message: string) {
    const key = `${document.uri.toString()}\n${message}`;
    if (!this.#noted.has(key)) {
      this.#noted.add(key);
      this.output.appendLine(`${basename(document.fileName)}: ${message}`);
    }
  }

  #clearNotes(document: vscode.TextDocument) {
    const prefix = `${document.uri.toString()}\n`;
    for (const key of [...this.#noted]) {
      if (key.startsWith(prefix)) {
        this.#noted.delete(key);
      }
    }
  }

  static isEnabled(document: vscode.TextDocument): boolean {
    return vscode.workspace.getConfiguration("indigoDriver", document.uri).get<boolean>("cLanguageFeatures", false);
  }

  /** Directory of the .driver file that a generated source belongs to. */
  originOf(generatedPath: string): string | undefined {
    return this.#origins.get(generatedPath);
  }

  /** Forget a closed document: when it opens again its version starts over, so nothing may be kept for it. */
  async evict(document: vscode.TextDocument) {
    const key = document.uri.toString();
    this.#states.delete(key);
    this.#pending.delete(key);
    this.#failed.delete(key);
    this.#clearNotes(document);
    const published = this.#published.get(key);
    this.#published.delete(key);
    if (published) {
      this.#origins.delete(published.path);
      await removeScratch(published.path);
    }
  }

  /** The generator path may have changed: a failure is worth trying again. */
  resetFailures() {
    this.#failed.clear();
  }

  async sync(document: vscode.TextDocument): Promise<ShadowState | undefined> {
    const key = document.uri.toString();
    const version = document.version;
    const text = document.getText();
    const state = this.#states.get(key);
    if (state?.version === version && state.text === text) {
      return state;
    }
    const failed = this.#failed.get(key);
    if (failed?.version === version && failed.text === text) {
      return undefined;
    }
    const pending = this.#pending.get(key);
    if (pending?.version === version && pending.text === text) {
      return pending.promise;
    }
    const run = (this.#chains.get(key) ?? Promise.resolve()).then(() => this.#generate(document));
    const settled = run.then(
      (): undefined => undefined,
      (): undefined => undefined,
    );
    this.#chains.set(key, settled);
    this.#pending.set(key, { version, text, promise: run });
    void settled.then(() => {
      if (this.#chains.get(key) === settled) {
        this.#chains.delete(key);
      }
      if (this.#pending.get(key)?.promise === run) {
        this.#pending.delete(key);
      }
    });
    return run;
  }

  async #generate(document: vscode.TextDocument): Promise<ShadowState | undefined> {
    try {
      return await this.#generateUnsafe(document);
    } catch (error) {
      this.output.appendLine(`${basename(document.fileName)}: C language features failed: ${error}`);
      return undefined;
    }
  }

  async #generateUnsafe(document: vscode.TextDocument): Promise<ShadowState | undefined> {
    const key = document.uri.toString();
    this.#states.delete(key);
    if (!vscode.workspace.isTrusted) {
      this.note(document, "C language features are off in an untrusted workspace.");
      return undefined;
    }
    if (document.uri.scheme !== "file") {
      this.note(document, "C language features need a .driver file saved on disk.");
      return undefined;
    }
    // Read once, at the start of this run: the document is live and may change while the run is going on.
    const version = document.version;
    const text = document.getText();
    const analysis = this.cache.get(document);
    const name = analysis.root && generatedSourceName(analysis.root);
    if (!analysis.root || !name) {
      this.note(document, "C language features need a driver name and at least one device block.");
      return undefined;
    }
    if (analysis.syntax.some((problem) => problem.severity === "error")) {
      this.note(document, "C language features pause while the definition has syntax errors.");
      return undefined;
    }
    const dir = join(
      this.storage.fsPath,
      "shadow",
      createHash("sha1").update(document.fileName).digest("hex").slice(0, 12),
    );
    // The generator writes into its own folder. The C file the editor sees is a separate scratch file next to a copy
    // of the generated header, so that the generator never rewrites a file the editor has open.
    const generatorDir = join(dir, "generator");
    await mkdir(generatorDir, { recursive: true });
    const definition = join(generatorDir, basename(document.fileName));
    await writeFile(definition, text);
    const configured = vscode.workspace.getConfiguration("indigoDriver", document.uri).get<string>("generatorPath", "");
    const executable = configured.trim() || "indigo_generator";
    const result = await runGenerator(executable, definition, generatorDir);
    if (result.missing || result.code !== 0) {
      this.#failed.set(key, { version, text });
      if (result.missing) {
        this.#warnOnce(`C language features need indigo_generator: cannot run '${executable}'.`);
      } else {
        this.output.appendLine(`C language features: the generator failed on ${document.fileName}\n${result.output}`);
      }
      return undefined;
    }
    const generated = await readFile(join(generatorDir, name), "utf8");
    const header = name.replace(/\.(?:c|cpp)$/, ".h");
    await copyFile(join(generatorDir, header), join(dir, header));
    const uri = await this.#publish(key, document, dir, name, generated);
    if (document.version !== version) {
      return undefined;
    }
    const nodes: Node[] = [];
    walk(analysis.root, (node) => node.kind === "code" && nodes.push(node));
    const state = { uri, map: buildShadowMap(text, nodes, generated), version, text };
    this.#states.set(key, state);
    this.#clearNotes(document);
    return state;
  }

  /**
   * A new file for every different generated text, so the C/C++ extension never sees a stale one; the previous file
   * goes once the new one is open. An unchanged file is reused, as long as it is still there and still open.
   */
  async #publish(key: string, document: vscode.TextDocument, dir: string, name: string, generated: string) {
    const previous = this.#published.get(key);
    if (previous?.generated === generated && existsSync(previous.path)) {
      const uri = vscode.Uri.file(previous.path);
      await touch(previous.path);
      // VS Code lets go of hidden documents after a while. The C/C++ extension then analyzes the file again.
      if (!vscode.workspace.textDocuments.some((open) => open.uri.fsPath === previous.path)) {
        await vscode.workspace.openTextDocument(uri);
        await this.#waitUntilAnalyzed(uri, generated);
      }
      return uri;
    }
    const path = await openScratch(dir, "shadow", name.endsWith(".cpp") ? ".cpp" : ".c", generated);
    this.#origins.set(path, dirname(document.fileName));
    const uri = vscode.Uri.file(path);
    await this.#waitUntilAnalyzed(uri, generated);
    this.#published.set(key, { generated, path });
    if (previous) {
      await removeScratch(previous.path);
      this.#origins.delete(previous.path);
    }
    return uri;
  }

  /**
   * A file the C/C++ extension has just been given is empty-handed until it has analyzed it, which takes a moment.
   * Ask about a symbol of the file until it answers. If it does not within the time limit, stop waiting for a while:
   * that would only add a pause to every request.
   */
  async #waitUntilAnalyzed(uri: vscode.Uri, generated: string) {
    const probe = findProbe(generated);
    if (Date.now() < this.#skipWaitUntil || !probe || !(await activateCppTools())) {
      return;
    }
    const position = new vscode.Position(probe.line, probe.col);
    const started = Date.now();
    while (Date.now() - started < this.wait.timeoutMs) {
      const remaining = this.wait.timeoutMs - (Date.now() - started);
      const hovers = await withTimeout(
        vscode.commands.executeCommand<vscode.Hover[] | undefined>("vscode.executeHoverProvider", uri, position),
        remaining,
      );
      if (hovers && hovers.length > 0) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, this.wait.intervalMs));
    }
    this.#skipWaitUntil = Date.now() + SKIP_WAIT_MS;
    this.output.appendLine(
      `The C/C++ extension gave no answer for the generated file within ${this.wait.timeoutMs / 1000} s: the C features will not wait for it for the next ${SKIP_WAIT_MS / 60000} minutes, so answers may be missing right after an edit.`,
    );
  }

  #warnOnce(message: string) {
    this.output.appendLine(message);
    if (!this.#warned) {
      this.#warned = true;
      vscode.window.showWarningMessage(`${message} Set 'indigoDriver.generatorPath'.`);
    }
  }
}
