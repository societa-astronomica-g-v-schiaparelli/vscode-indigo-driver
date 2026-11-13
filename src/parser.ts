import { CODE_BLOCKS, type ContextName, CONTEXTS, DEVICE_TYPES, PROPERTY_KINDS, TRANSPORTS } from "./schema";

export type NodeKind =
  "driver" | "transport" | "pattern" | "device" | "property" | "item" | "reject_change" | "code" | "attribute";

export interface Node {
  kind: NodeKind;
  /** Block keyword (`aux`, `switch`, `on_connect`...) or attribute name. */
  keyword: string;
  /** Declaration identifier: driver name, property id or item id. */
  name?: string;
  /** Range of the keyword (attributes: the attribute name). */
  keywordStart: number;
  keywordEnd: number;
  /** Range of the declaration identifier. */
  nameStart: number;
  nameEnd: number;
  /** Whole node, from keyword to closing brace or semicolon. */
  start: number;
  end: number;
  /** Content between the braces; meaningful only when `hasBody` is true. */
  hasBody: boolean;
  bodyStart: number;
  bodyEnd: number;
  /** Attributes only: raw value text, without quotes for strings. */
  value?: string;
  valueStart: number;
  valueEnd: number;
  isString?: boolean;
  /** False when the closing brace is missing. */
  closed: boolean;
  children: Node[];
  parent?: Node;
}

export interface Problem {
  start: number;
  end: number;
  message: string;
  severity: "error" | "warning" | "info" | "hint";
}

export interface ParseResult {
  root?: Node;
  problems: Problem[];
}

export function contextOf(node: Node): ContextName | undefined {
  switch (node.kind) {
    case "driver":
      return "driver";
    case "transport":
      return node.keyword as ContextName;
    case "pattern":
      return "pattern";
    case "device":
      return "device";
    case "property":
      return node.keyword === "inherited" ? "inherited" : "property";
    case "item":
      return "item";
    case "reject_change":
      return "reject_change";
    default:
      return undefined;
  }
}

/** ASCII only, like the generator: JS `\s` would also accept NBSP and friends. */
const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
const isIdentifierStart = (c: string) => /[A-Za-z]/.test(c);
const isIdentifierPart = (c: string) => /[A-Za-z0-9_]/.test(c);

/**
 * Index of the brace closing a code block whose content starts at `from`, or -1.
 * Mirrors the generator: braces count only outside strings, character literals and comments.
 */
export function scanCode(text: string, from: number): number {
  let depth = 0;
  let state: "code" | "string" | "char" | "line" | "block" = "code";
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (state === "string" || state === "char") {
      if (c === "\\") {
        i++;
      } else if (c === (state === "string" ? '"' : "'")) {
        state = "code";
      }
    } else if (state === "line") {
      if (c === "\n") {
        state = "code";
      }
    } else if (state === "block") {
      if (c === "*" && n === "/") {
        i++;
        state = "code";
      }
    } else if (c === "\\") {
      i++;
    } else if (c === '"') {
      state = "string";
    } else if (c === "'") {
      state = "char";
    } else if (c === "/" && n === "/") {
      i++;
      state = "line";
    } else if (c === "/" && n === "*") {
      i++;
      state = "block";
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      if (depth === 0) {
        return i;
      }
      depth--;
    }
  }
  return -1;
}

class Parser {
  readonly problems: Problem[] = [];
  #text: string;
  #i = 0;

  constructor(text: string) {
    this.#text = text;
  }

  parse(): Node | undefined {
    this.#skipTrivia();
    if (this.#i >= this.#text.length) {
      return undefined;
    }
    const keyword = this.#readIdentifier();
    if (!keyword || keyword.text !== "driver") {
      this.#problem(this.#i, this.#i + 1, "Expected 'driver' at the start of the file");
      return undefined;
    }
    this.#skipTrivia();
    const name = this.#readIdentifier();
    if (!name) {
      this.#problem(keyword.start, keyword.end, "Expected the driver name after 'driver'");
      return undefined;
    }
    const root = this.#newNode("driver", keyword);
    root.name = name.text;
    root.nameStart = name.start;
    root.nameEnd = name.end;
    root.end = name.end;
    if (!this.#expectBrace(keyword.text, root)) {
      return root;
    }
    this.#parseBody(root);
    this.#skipTrivia();
    if (this.#i < this.#text.length) {
      this.#problem(this.#i, this.#text.length, "Unexpected content after the driver block", "warning");
    }
    return root;
  }

  #problem(start: number, end: number, message: string, severity: Problem["severity"] = "error") {
    this.problems.push({ start, end: Math.max(end, start + 1), message, severity });
  }

  #newNode(kind: NodeKind, keyword: { text: string; start: number; end: number }, parent?: Node): Node {
    const node: Node = {
      kind,
      keyword: keyword.text,
      keywordStart: keyword.start,
      keywordEnd: keyword.end,
      nameStart: keyword.start,
      nameEnd: keyword.end,
      start: keyword.start,
      end: keyword.end,
      hasBody: false,
      bodyStart: keyword.end,
      bodyEnd: keyword.end,
      valueStart: keyword.end,
      valueEnd: keyword.end,
      closed: true,
      children: [],
      parent,
    };
    parent?.children.push(node);
    return node;
  }

  #skipTrivia(record = true) {
    const t = this.#text;
    while (this.#i < t.length) {
      const c = t[this.#i];
      if (isSpace(c)) {
        this.#i++;
      } else if (c === "/" && t[this.#i + 1] === "/") {
        while (this.#i < t.length && t[this.#i] !== "\n") {
          this.#i++;
        }
      } else if (c === "/" && t[this.#i + 1] === "*") {
        const end = t.indexOf("*/", this.#i + 2);
        const stop = end < 0 ? t.length : end + 2;
        if (record) {
          this.#problem(this.#i, stop, "Block comments are only allowed inside code blocks: use '//'");
        }
        this.#i = stop;
      } else {
        return;
      }
    }
  }

  #peek(): string {
    const save = this.#i;
    this.#skipTrivia(false);
    const c = this.#text[this.#i] ?? "";
    this.#i = save;
    return c;
  }

  #readIdentifier(): { text: string; start: number; end: number } | undefined {
    const t = this.#text;
    if (this.#i >= t.length || !isIdentifierStart(t[this.#i])) {
      return undefined;
    }
    const start = this.#i;
    while (this.#i < t.length && isIdentifierPart(t[this.#i])) {
      this.#i++;
    }
    return { text: t.slice(start, this.#i), start, end: this.#i };
  }

  /** Consume `{` and record where the body starts. */
  #expectBrace(what: string, node: Node): boolean {
    this.#skipTrivia();
    if (this.#text[this.#i] !== "{") {
      this.#problem(node.keywordStart, node.keywordEnd, `Expected '{' after '${what}'`);
      return false;
    }
    this.#i++;
    node.hasBody = true;
    node.bodyStart = this.#i;
    node.bodyEnd = this.#i;
    node.end = this.#i;
    return true;
  }

  #parseBody(parent: Node) {
    const t = this.#text;
    for (;;) {
      this.#skipTrivia();
      if (this.#i >= t.length) {
        parent.closed = false;
        parent.end = t.length;
        parent.bodyEnd = t.length;
        this.#problem(parent.keywordStart, parent.keywordEnd, `Unclosed '${parent.keyword}' block`);
        return;
      }
      const c = t[this.#i];
      if (c === "}") {
        parent.bodyEnd = this.#i;
        this.#i++;
        parent.end = this.#i;
        return;
      }
      if (c === ";") {
        this.#problem(this.#i, this.#i + 1, "Unexpected ';'");
        this.#i++;
        continue;
      }
      const id = this.#readIdentifier();
      if (!id) {
        this.#problem(this.#i, this.#i + 1, `Unexpected character '${c}'`);
        this.#i++;
        continue;
      }
      this.#parseStatement(parent, id);
    }
  }

  #parseStatement(parent: Node, id: { text: string; start: number; end: number }) {
    const next = this.#peek();
    if (next === "=") {
      this.#parseAttribute(parent, id);
    } else if (CODE_BLOCKS.includes(id.text) && next === "{") {
      this.#parseCode(parent, id);
    } else if (DEVICE_TYPES.includes(id.text) && (next === "{" || next === ";")) {
      this.#parseBlock(parent, "device", id);
    } else if (PROPERTY_KINDS.includes(id.text) && isIdentifierStart(next)) {
      this.#parseNamed(parent, "property", id);
    } else if (id.text === "item" && isIdentifierStart(next)) {
      this.#parseNamed(parent, "item", id);
    } else if (TRANSPORTS.includes(id.text) && (next === "{" || next === ";")) {
      this.#parseBlock(parent, "transport", id);
    } else if (id.text === "pattern" && (next === "{" || next === ";")) {
      this.#parseBlock(parent, "pattern", id);
    } else if (id.text === "reject_change" && next === "{") {
      this.#parseBlock(parent, "reject_change", id);
    } else if (next === "{" || isIdentifierStart(next)) {
      this.#problem(id.start, id.end, `Unknown block or incomplete statement '${id.text}'`);
    } else {
      this.#problem(id.start, id.end, `Expected '=' after '${id.text}'`);
    }
  }

  #parseCode(parent: Node, id: { text: string; start: number; end: number }) {
    const node = this.#newNode("code", id, parent);
    this.#expectBrace(id.text, node);
    const close = scanCode(this.#text, this.#i);
    if (close < 0) {
      node.closed = false;
      node.bodyEnd = this.#text.length;
      node.end = this.#text.length;
      this.#i = this.#text.length;
      this.#problem(id.start, id.end, `Unclosed '${id.text}' code block`);
      return;
    }
    node.bodyEnd = close;
    this.#i = close + 1;
    node.end = this.#i;
  }

  #parseBlock(parent: Node, kind: NodeKind, id: { text: string; start: number; end: number }) {
    const node = this.#newNode(kind, id, parent);
    if (this.#peek() === ";") {
      this.#skipTrivia();
      this.#i++;
      node.end = this.#i;
      return;
    }
    if (this.#expectBrace(id.text, node)) {
      this.#parseBody(node);
    }
  }

  #parseNamed(parent: Node, kind: NodeKind, id: { text: string; start: number; end: number }) {
    this.#skipTrivia();
    const name = this.#readIdentifier();
    const node = this.#newNode(kind, id, parent);
    if (!name) {
      return;
    }
    node.name = name.text;
    node.nameStart = name.start;
    node.nameEnd = name.end;
    node.end = name.end;
    if (this.#peek() === ";") {
      this.#skipTrivia();
      this.#i++;
      node.end = this.#i;
      return;
    }
    if (this.#expectBrace(id.text, node)) {
      this.#parseBody(node);
    }
  }

  #parseAttribute(parent: Node, id: { text: string; start: number; end: number }) {
    const t = this.#text;
    const node = this.#newNode("attribute", id, parent);
    this.#skipTrivia();
    this.#i++; // '='
    const context = contextOf(parent);
    const kind = context ? CONTEXTS[context].attributes[id.text]?.kind : undefined;
    this.#skipTrivia();
    if (kind === "string") {
      if (this.#readString(node, id)) {
        return;
      }
    } else if (kind === "boolean" || kind === "integer" || kind === "identifier") {
      // The generator reads a single token and makes the ';' optional.
      const pattern = {
        boolean: /^(?:true|false)(?![A-Za-z0-9_])/,
        integer: /^[0-9-][0-9.\-Ee]*/,
        identifier: /^[A-Za-z][A-Za-z0-9_]*/,
      }[kind];
      const token = pattern.exec(t.slice(this.#i, this.#i + 80));
      if (token) {
        node.value = token[0];
        node.valueStart = this.#i;
        node.valueEnd = this.#i + token[0].length;
        this.#i = node.valueEnd;
        this.#optionalSemicolon(node);
        return;
      }
      const expected = { boolean: "true or false", integer: "a number", identifier: "an identifier" }[kind];
      this.#problem(id.start, id.end, `'${id.text}' expects ${expected}`);
    }
    this.#readExpression(node, id);
  }

  /** String literal, no escapes: the first closing quote ends it. Returns false when it is not a string. */
  #readString(node: Node, id: { text: string; start: number; end: number }): boolean {
    const t = this.#text;
    if (t[this.#i] !== '"') {
      this.#problem(id.start, id.end, `'${id.text}' expects a string literal`);
      return false;
    }
    const close = t.indexOf('"', this.#i + 1);
    node.valueStart = this.#i + 1;
    if (close < 0) {
      this.#problem(this.#i, t.length, "Unterminated string");
      node.valueEnd = t.length;
      node.value = t.slice(node.valueStart);
      node.end = t.length;
      this.#i = t.length;
      return true;
    }
    node.isString = true;
    node.valueEnd = close;
    node.value = t.slice(node.valueStart, close);
    this.#i = close + 1;
    this.#optionalSemicolon(node);
    return true;
  }

  #optionalSemicolon(node: Node) {
    node.end = this.#i;
    if (this.#peek() === ";") {
      this.#skipTrivia();
      this.#i++;
      node.end = this.#i;
    }
  }

  /** C expression: everything up to the first ';', even one inside a string, like the generator. */
  #readExpression(node: Node, id: { text: string; start: number; end: number }) {
    const t = this.#text;
    const start = this.#i;
    let depth = 0;
    let inString = false;
    let end = -1;
    for (; this.#i < t.length; this.#i++) {
      const c = t[this.#i];
      if (c === ";") {
        end = this.#i;
        break;
      }
      if (c === '"' && t[this.#i - 1] !== "\\") {
        inString = !inString;
      } else if (!inString && c === "{") {
        depth++;
      } else if (!inString && c === "}") {
        // An unbalanced '}' means the statement lost its ';'.
        if (depth === 0) {
          break;
        }
        depth--;
      }
    }
    let valueEnd = end < 0 ? this.#i : end;
    while (valueEnd > start && isSpace(t[valueEnd - 1])) {
      valueEnd--;
    }
    node.value = t.slice(start, valueEnd);
    node.valueStart = start;
    node.valueEnd = valueEnd;
    if (end < 0) {
      this.#problem(id.start, valueEnd > start ? valueEnd : id.end, `Missing ';' after the value of '${id.text}'`);
      node.end = valueEnd;
      return;
    }
    this.#i = end + 1;
    node.end = this.#i;
    if (node.value === "") {
      this.#problem(id.start, node.end, `'${id.text}' has no value`);
    }
  }
}

export function parse(text: string): ParseResult {
  const parser = new Parser(text);
  const root = parser.parse();
  return { root, problems: parser.problems };
}

export function walk(node: Node, visit: (node: Node) => void) {
  visit(node);
  for (const child of node.children) {
    walk(child, visit);
  }
}

/** Deepest block (not attribute, not code) whose body contains the offset. */
export function blockAt(root: Node, offset: number): Node {
  let best = root;
  for (const child of root.children) {
    if (child.kind === "attribute" || child.kind === "code") {
      continue;
    }
    if (child.hasBody && offset >= child.bodyStart && offset <= (child.closed ? child.bodyEnd : child.end)) {
      best = blockAt(child, offset);
    }
  }
  return best;
}

/** Deepest node (including attributes and code blocks) covering the offset. */
export function nodeAt(root: Node, offset: number): Node {
  for (const child of root.children) {
    if (offset >= child.start && offset <= child.end) {
      return nodeAt(child, offset);
    }
  }
  return root;
}
