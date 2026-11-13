import * as vscode from "vscode";

import { activateCppTools } from "./modelFile";
import { nodeAt } from "./parser";
import type { AnalysisCache } from "./providers";
import { ShadowSource, type ShadowState } from "./shadow";

interface Target {
  state: ShadowState;
  position: vscode.Position;
}

/**
 * Completion, hover, go to definition and signature help inside the C code blocks of a .driver file. Requests are
 * forwarded to whatever extension provides C language features (by default Microsoft C/C++) on the generated
 * source, and the answers are mapped back to the .driver file.
 */
export class DriverCLanguageProvider
  implements
    vscode.CompletionItemProvider,
    vscode.HoverProvider,
    vscode.DefinitionProvider,
    vscode.SignatureHelpProvider
{
  constructor(
    private readonly cache: AnalysisCache,
    private readonly shadow: ShadowSource,
  ) {}

  async #target(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken,
  ): Promise<Target | undefined> {
    const { root } = this.cache.get(document);
    if (!root) {
      return undefined;
    }
    const offset = document.offsetAt(position);
    const node = nodeAt(root, offset);
    if (node.kind !== "code" || offset < node.bodyStart || offset > node.bodyEnd) {
      return undefined;
    }
    if (!ShadowSource.isEnabled(document)) {
      this.shadow.note(
        document,
        "C language features are off: turn on 'indigoDriver.cLanguageFeatures' to use them in code blocks.",
      );
      return undefined;
    }
    // The position belongs to this version of the text: an answer for a later one would point somewhere else.
    const version = document.version;
    await activateCppTools();
    const state = await this.shadow.sync(document);
    if (!state || token?.isCancellationRequested || state.version !== version || document.version !== version) {
      return undefined;
    }
    const mapped = state.map.toGenerated({ line: position.line, col: position.character });
    return mapped ? { state, position: new vscode.Position(mapped.line, mapped.col) } : undefined;
  }

  #toDriver(state: ShadowState, range: vscode.Range): vscode.Range | undefined {
    const start = state.map.toDriver({ line: range.start.line, col: range.start.character });
    const end = state.map.toDriver({ line: range.end.line, col: range.end.character });
    return start && end
      ? new vscode.Range(new vscode.Position(start.line, start.col), new vscode.Position(end.line, end.col))
      : undefined;
  }

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext,
  ): Promise<vscode.CompletionList | undefined> {
    const target = await this.#target(document, position, token);
    if (!target) {
      return undefined;
    }
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      target.state.uri,
      target.position,
      context.triggerCharacter,
    );
    const items = (list?.items ?? []).map((item) => {
      const range = item.range;
      if (range instanceof vscode.Range) {
        item.range = this.#toDriver(target.state, range);
      } else if (range) {
        const inserting = this.#toDriver(target.state, range.inserting);
        const replacing = this.#toDriver(target.state, range.replacing);
        item.range = inserting && replacing ? { inserting, replacing } : undefined;
      }
      // Edits elsewhere (such as a suggested #include) point into the generated file.
      item.additionalTextEdits = undefined;
      return item;
    });
    return new vscode.CompletionList(items, list?.isIncomplete ?? false);
  }

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    const target = await this.#target(document, position, token);
    if (!target) {
      return undefined;
    }
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      target.state.uri,
      target.position,
    );
    if (!hovers || hovers.length === 0) {
      return undefined;
    }
    const range = hovers.map((hover) => hover.range && this.#toDriver(target.state, hover.range)).find(Boolean);
    return new vscode.Hover(
      hovers.flatMap((hover) => hover.contents),
      range,
    );
  }

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken,
  ): Promise<vscode.LocationLink[] | undefined> {
    const target = await this.#target(document, position, token);
    if (!target) {
      return undefined;
    }
    const found = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
      "vscode.executeDefinitionProvider",
      target.state.uri,
      target.position,
    );
    return (found ?? []).flatMap((entry): vscode.LocationLink[] => {
      const link =
        "targetUri" in entry
          ? entry
          : { targetUri: entry.uri, targetRange: entry.range, targetSelectionRange: entry.range };
      const origin = link.originSelectionRange && this.#toDriver(target.state, link.originSelectionRange);
      if (link.targetUri.toString() !== target.state.uri.toString()) {
        return [{ ...link, originSelectionRange: origin }];
      }
      // A definition inside a code block of the generated file goes back to the .driver file. One outside the
      // blocks would open a scratch file that is deleted on the next change, so it is left out.
      const range = this.#toDriver(target.state, link.targetRange);
      if (!range) {
        return [];
      }
      const selection = link.targetSelectionRange && this.#toDriver(target.state, link.targetSelectionRange);
      return [
        {
          originSelectionRange: origin,
          targetUri: document.uri,
          targetRange: range,
          targetSelectionRange: selection ?? range,
        },
      ];
    });
  }

  async provideSignatureHelp(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.SignatureHelpContext,
  ): Promise<vscode.SignatureHelp | undefined> {
    const target = await this.#target(document, position, token);
    if (!target) {
      return undefined;
    }
    return vscode.commands.executeCommand<vscode.SignatureHelp>(
      "vscode.executeSignatureHelpProvider",
      target.state.uri,
      target.position,
      context.triggerCharacter,
    );
  }
}
