import * as vscode from "vscode";

import { type Analysis, analyze } from "./analysis";
import { blockAt, contextOf, type Node, nodeAt, type Problem } from "./parser";
import { BLOCK_DOCS, CODE_BLOCKS, CONTEXTS, DEVICE_TYPES, PROPERTY_KINDS, TRANSPORTS } from "./schema";

export const LANGUAGE_ID = "indigo-driver";

/** Parses documents once per version and shares the result between providers. */
export class AnalysisCache {
  #entries = new Map<string, { version: number; analysis: Analysis }>();

  get(document: vscode.TextDocument): Analysis {
    const key = document.uri.toString();
    const cached = this.#entries.get(key);
    if (cached?.version === document.version) {
      return cached.analysis;
    }
    const analysis = analyze(document.getText());
    this.#entries.set(key, { version: document.version, analysis });
    return analysis;
  }

  delete(document: vscode.TextDocument) {
    this.#entries.delete(document.uri.toString());
  }
}

const SEVERITY: Record<Problem["severity"], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

/** Publishes parser and lint findings while the user types. */
export class DriverDiagnostics implements vscode.Disposable {
  #collection = vscode.languages.createDiagnosticCollection("indigo-driver");
  #timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly cache: AnalysisCache) {}

  schedule(document: vscode.TextDocument) {
    if (document.languageId !== LANGUAGE_ID) {
      return;
    }
    const key = document.uri.toString();
    clearTimeout(this.#timers.get(key));
    this.#timers.set(
      key,
      setTimeout(() => this.refresh(document), 250),
    );
  }

  refresh(document: vscode.TextDocument) {
    if (document.languageId !== LANGUAGE_ID) {
      return;
    }
    const config = vscode.workspace.getConfiguration("indigoDriver", document.uri);
    if (!config.get<boolean>("lint.enable", true)) {
      this.#collection.delete(document.uri);
      return;
    }
    const analysis = this.cache.get(document);
    const diagnostics = [...analysis.syntax, ...analysis.semantic].map((problem) => {
      const range = new vscode.Range(document.positionAt(problem.start), document.positionAt(problem.end));
      const diagnostic = new vscode.Diagnostic(range, problem.message, SEVERITY[problem.severity]);
      diagnostic.source = "indigo-driver";
      return diagnostic;
    });
    this.#collection.set(document.uri, diagnostics);
  }

  clear(document: vscode.TextDocument) {
    clearTimeout(this.#timers.get(document.uri.toString()));
    this.#timers.delete(document.uri.toString());
    this.#collection.delete(document.uri);
  }

  dispose() {
    this.#timers.forEach(clearTimeout);
    this.#collection.dispose();
  }
}

function stringValue(node: Node | undefined): string | undefined {
  const value = node?.value?.trim();
  return value?.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function symbolFor(document: vscode.TextDocument, node: Node): vscode.DocumentSymbol | undefined {
  let name: string;
  let kind: vscode.SymbolKind;
  switch (node.kind) {
    case "driver":
      name = `driver ${node.name ?? ""}`;
      kind = vscode.SymbolKind.Module;
      break;
    case "device": {
      const label = stringValue(node.children.find((c) => c.kind === "attribute" && c.keyword === "name"));
      name = label ? `${node.keyword} "${label}"` : node.keyword;
      kind = vscode.SymbolKind.Class;
      break;
    }
    case "property":
      name = `${node.keyword} ${node.name ?? ""}`;
      kind = vscode.SymbolKind.Property;
      break;
    case "item":
      name = `item ${node.name ?? ""}`;
      kind = vscode.SymbolKind.Field;
      break;
    case "transport":
      name = node.keyword;
      kind = vscode.SymbolKind.Interface;
      break;
    case "code":
      name = node.keyword;
      kind = vscode.SymbolKind.Function;
      break;
    case "reject_change":
      name = node.keyword;
      kind = vscode.SymbolKind.Event;
      break;
    default:
      return undefined;
  }
  // The selection must stay inside the range, also while the name is typed and the brace is still missing.
  const range = new vscode.Range(
    document.positionAt(node.start),
    document.positionAt(Math.max(node.end, node.nameEnd)),
  );
  const selection = new vscode.Range(document.positionAt(node.keywordStart), document.positionAt(node.nameEnd));
  const symbol = new vscode.DocumentSymbol(name.trim(), "", kind, range, selection);
  symbol.children = node.children.flatMap((child): vscode.DocumentSymbol[] => {
    const nested = symbolFor(document, child);
    return nested ? [nested] : [];
  });
  return symbol;
}

export class DriverSymbolProvider implements vscode.DocumentSymbolProvider {
  constructor(private readonly cache: AnalysisCache) {}

  provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    const { root } = this.cache.get(document);
    const symbol = root && symbolFor(document, root);
    return symbol ? [symbol] : [];
  }
}

export class DriverFoldingProvider implements vscode.FoldingRangeProvider {
  constructor(private readonly cache: AnalysisCache) {}

  provideFoldingRanges(document: vscode.TextDocument): vscode.FoldingRange[] {
    const { root } = this.cache.get(document);
    const ranges: vscode.FoldingRange[] = [];
    const visit = (node: Node) => {
      if (node.hasBody) {
        const start = document.positionAt(node.start).line;
        const end = document.positionAt(node.closed ? node.end - 1 : node.end).line - 1;
        if (end > start) {
          ranges.push(new vscode.FoldingRange(start, end));
        }
      }
      node.children.forEach(visit);
    };
    if (root) {
      visit(root);
    }
    return ranges;
  }
}

function blockSnippet(keyword: string): string {
  if (DEVICE_TYPES.includes(keyword)) {
    return `${keyword} {\n\tname = "\${1:Device name}";\n\t$0\n}`;
  }
  if (keyword === "inherited") {
    return `inherited \${1:PROPERTY} {\n\t$0\n}`;
  }
  if (PROPERTY_KINDS.includes(keyword)) {
    return `${keyword} \${1:X_PROPERTY} {\n\tname = "\${1}";\n\tlabel = "\${2:Label}";\n\t$0\n}`;
  }
  if (keyword === "item") {
    return `item \${1:ITEM} {\n\tlabel = "\${2:Label}";\n\t$0\n}`;
  }
  if (keyword === "reject_change") {
    return 'reject_change {\n\tcondition = ${1:condition};\n\tmessage = "${2:Message}";\n}';
  }
  return `${keyword} {\n\t$0\n}`;
}

export class DriverCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly cache: AnalysisCache) {}

  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
    if (linePrefix.includes("//")) {
      return [];
    }
    const { root } = this.cache.get(document);
    if (!root) {
      return [];
    }
    const offset = document.offsetAt(position);
    const node = nodeAt(root, offset);
    if (node.kind === "code" && offset >= node.bodyStart && offset <= node.bodyEnd) {
      return [];
    }
    if (node.kind === "attribute" && node.parent && this.#insideValue(document, node, offset)) {
      return this.#valueItems(node);
    }
    const block = blockAt(root, offset);
    const context = contextOf(block);
    if (!context) {
      return [];
    }
    const spec = CONTEXTS[context];
    const present = new Set(block.children.filter((c) => c.kind === "attribute").map((c) => c.keyword));
    const items: vscode.CompletionItem[] = [];
    for (const [name, attribute] of Object.entries(spec.attributes)) {
      if (present.has(name)) {
        continue;
      }
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Property);
      item.detail = attribute.kind + (attribute.mandatory ? " (mandatory)" : "");
      item.documentation = new vscode.MarkdownString(attribute.doc);
      item.insertText =
        attribute.kind === "string"
          ? new vscode.SnippetString(`${name} = "$1";`)
          : new vscode.SnippetString(`${name} = $1;`);
      items.push(item);
    }
    for (const keyword of spec.blocks) {
      const isCode = CODE_BLOCKS.includes(keyword);
      const kind = isCode
        ? vscode.CompletionItemKind.Function
        : TRANSPORTS.includes(keyword)
          ? vscode.CompletionItemKind.Interface
          : vscode.CompletionItemKind.Class;
      const item = new vscode.CompletionItem(keyword, kind);
      item.detail = isCode ? "code block" : "block";
      item.documentation = new vscode.MarkdownString(BLOCK_DOCS[keyword]?.doc ?? "");
      item.insertText = new vscode.SnippetString(blockSnippet(keyword));
      items.push(item);
    }
    return items;
  }

  #insideValue(document: vscode.TextDocument, node: Node, offset: number): boolean {
    const text = document.getText();
    const limit = text[node.end - 1] === ";" ? node.end - 1 : node.end;
    return offset <= limit && text.slice(node.keywordEnd, offset).includes("=");
  }

  #valueItems(node: Node): vscode.CompletionItem[] {
    const context = node.parent && contextOf(node.parent);
    const values = context && CONTEXTS[context].attributes[node.keyword]?.values;
    return (values ?? []).map((value) => new vscode.CompletionItem(value, vscode.CompletionItemKind.EnumMember));
  }
}

export class DriverHoverProvider implements vscode.HoverProvider {
  constructor(private readonly cache: AnalysisCache) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const { root } = this.cache.get(document);
    if (!root) {
      return undefined;
    }
    const offset = document.offsetAt(position);
    const node = nodeAt(root, offset);
    if (offset < node.keywordStart || offset > node.keywordEnd) {
      return undefined;
    }
    const range = new vscode.Range(document.positionAt(node.keywordStart), document.positionAt(node.keywordEnd));
    let markdown: string;
    if (node.kind === "attribute") {
      const context = node.parent && contextOf(node.parent);
      const attribute = context && CONTEXTS[context].attributes[node.keyword];
      if (attribute) {
        markdown = `**${node.keyword}** (${attribute.kind})\n\n${attribute.doc}`;
      } else if (context === "driver") {
        markdown = `**${node.keyword}**\n\nDriver constant, emitted as \`#define ${node.keyword} ...\`.`;
      } else {
        return undefined;
      }
    } else {
      const doc = BLOCK_DOCS[node.keyword]?.doc;
      if (!doc) {
        return undefined;
      }
      markdown = `**${node.keyword}**\n\n${doc}`;
    }
    return new vscode.Hover(new vscode.MarkdownString(markdown), range);
  }
}
