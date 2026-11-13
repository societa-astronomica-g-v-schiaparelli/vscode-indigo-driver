import type { Node } from "./parser";

/**
 * Formatting of the C code blocks of a .driver file with an ordinary C/C++ formatter.
 *
 * A block is not a C file by itself: most blocks hold statements and `data` holds struct members. Each block is
 * therefore wrapped (in a function or a struct) in a scratch C file, formatted there, unwrapped and re-indented to
 * the position of the block in the .driver file.
 */

export type BlockKind = "statements" | "members" | "declarations";

const DECLARATIONS = ["code", "include", "define"];

export function blockKind(keyword: string): BlockKind {
  if (keyword === "data") {
    return "members";
  }
  return DECLARATIONS.includes(keyword) ? "declarations" : "statements";
}

const MARKER = "//@indigo-block ";
const PROBE = "int probe;";

/** Code of a block without the blank lines around it. */
const trimBlankLines = (text: string) => text.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/(?:\r?\n[ \t]*)+$/, "");

/** The scratch file: a probe that reveals the indentation unit, then one wrapped block after each marker. */
export function buildScratch(blocks: { keyword: string; code: string }[]): string {
  const parts = [`void __indigo_probe(void) {\n${PROBE}\n}`];
  blocks.forEach(({ keyword, code }, index) => {
    const body = trimBlankLines(code);
    const kind = blockKind(keyword);
    parts.push(`${MARKER}${index}`);
    if (kind === "statements") {
      parts.push(`void __indigo_block_${index}(void) {\n${body}\n}`);
    } else if (kind === "members") {
      parts.push(`struct __indigo_data_${index} {\n${body}\n};`);
    } else {
      parts.push(body);
    }
  });
  return `${parts.join("\n")}\n`;
}

/**
 * Lines that the formatter moves as a whole instead of formatting them: those that start inside a block comment and
 * those of an `#if 0` region. Each comes with the index of the line that opens the comment or the region.
 */
function opaqueLines(lines: string[]): { line: number; anchor: number }[] {
  const found: { line: number; anchor: number }[] = [];
  let anchor = -1;
  let inComment = false;
  let region = 0;
  lines.forEach((row, line) => {
    const directive = inComment ? undefined : /^\s*#\s*(\w+)/.exec(row)?.[1];
    if (region > 0) {
      if (directive === "if" || directive === "ifdef" || directive === "ifndef") {
        region++;
      } else if (directive === "endif") {
        region--;
      } else if ((directive === "else" || directive === "elif") && region === 1) {
        region = 0;
      }
      if (region > 0) {
        found.push({ line, anchor });
      }
      return;
    }
    if (directive === "if" && /^\s*#\s*if\s+0\b/.test(row)) {
      region = 1;
      anchor = line;
      return;
    }
    if (inComment) {
      found.push({ line, anchor });
    }
    let quote = "";
    for (let i = 0; i < row.length; i++) {
      const c = row[i];
      if (inComment) {
        if (c === "*" && row[i + 1] === "/") {
          inComment = false;
          i++;
        }
      } else if (quote) {
        if (c === "\\") {
          i++;
        } else if (c === quote) {
          quote = "";
        }
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === "/" && row[i + 1] === "/") {
        break;
      } else if (c === "/" && row[i + 1] === "*") {
        inComment = true;
        anchor = line;
        i++;
      }
    }
  });
  return found;
}

export interface FormattedBlock {
  /** Lines of the block, each with its indentation expressed in levels and trailing continuation spaces. */
  lines: { levels: number; spaces: number; text: string }[];
}

function indentWidth(line: string, tabWidth: number): number {
  let width = 0;
  for (const c of line) {
    if (c === " ") {
      width++;
    } else if (c === "\t") {
      width += tabWidth;
    } else {
      break;
    }
  }
  return width;
}

/**
 * Split the formatted scratch file back into blocks. A block that the formatter changed beyond recognition (its
 * wrapper is gone) comes back as undefined and must be left alone.
 */
export function parseFormatted(
  formatted: string,
  blocks: { keyword: string; code: string }[],
  tabWidth: number,
): (FormattedBlock | undefined)[] {
  const rows = formatted.replace(/\r\n/g, "\n").split("\n");
  const probe = rows.find((row) => row.trim() === PROBE);
  const unit = probe ? indentWidth(probe, tabWidth) : 0;
  const segments: string[][] = blocks.map((): string[] => []);
  let current = -1;
  for (const row of rows) {
    const marker = row.startsWith(MARKER) ? Number(row.slice(MARKER.length)) : NaN;
    if (!Number.isNaN(marker)) {
      current = marker;
    } else if (current >= 0 && current < segments.length) {
      segments[current].push(row);
    }
  }
  return blocks.map(({ keyword, code }, index): FormattedBlock | undefined => {
    const kind = blockKind(keyword);
    const text = trimBlankLines(segments[index].join("\n"));
    let body: string | undefined = text;
    if (kind === "statements") {
      body = /^void __indigo_block_\d+\(void\)\s*\{\n([\s\S]*)\n\}$/.exec(text)?.[1];
    } else if (kind === "members") {
      body = /^struct __indigo_data_\d+\s*\{\n([\s\S]*)\n\};$/.exec(text)?.[1];
    }
    if (body === undefined) {
      return undefined;
    }
    // The wrapper adds one level to everything inside it.
    const wrapped = kind === "declarations" ? 0 : 1;
    const rows = trimBlankLines(body).split("\n");
    const lines = rows.map((row): FormattedBlock["lines"][number] => {
      const text = row.trim();
      if (text === "") {
        return { levels: 0, spaces: 0, text: "" };
      }
      const width = indentWidth(row, tabWidth);
      const levels = unit > 0 ? Math.floor(width / unit) : 0;
      return { levels: Math.max(levels - wrapped, 0), spaces: unit > 0 ? width - levels * unit : 0, text };
    });
    keepOpaqueOffsets(lines, rows, trimBlankLines(code).split("\n"), unit, tabWidth);
    return { lines };
  });
}

/**
 * The formatter shifts those lines by the move of the line that opens them, which drifts on every run. Keep them
 * where the author put them relative to that line instead.
 */
function keepOpaqueOffsets(
  lines: FormattedBlock["lines"],
  formatted: string[],
  original: string[],
  unit: number,
  tabWidth: number,
) {
  const after = opaqueLines(formatted);
  const before = opaqueLines(original.map((row) => row.replace(/\r$/, "")));
  if (unit <= 0 || tabWidth <= 0 || after.length !== before.length) {
    return;
  }
  // Columns, with one output indentation level being `tabWidth` columns wide.
  after.forEach((continuation, k) => {
    const offset = indentWidth(original[before[k].line], tabWidth) - indentWidth(original[before[k].anchor], tabWidth);
    const anchor = lines[continuation.anchor];
    const total = Math.max(anchor.levels * tabWidth + anchor.spaces + offset, 0);
    lines[continuation.line] = {
      ...lines[continuation.line],
      levels: Math.floor(total / tabWidth),
      spaces: total % tabWidth,
    };
  });
}

export interface Replacement {
  start: number;
  end: number;
  text: string;
}

/** Replacements of the bodies of the code nodes, given the scratch file after formatting. */
export function formattedReplacements(
  source: string,
  nodes: Pick<Node, "keyword" | "keywordStart" | "bodyStart" | "bodyEnd">[],
  formatted: string,
  tabSize: number,
  insertSpaces: boolean,
): Replacement[] {
  const blocks = nodes.map((node) => ({ keyword: node.keyword, code: source.slice(node.bodyStart, node.bodyEnd) }));
  const parsed = parseFormatted(formatted, blocks, tabSize);
  const unit = insertSpaces ? " ".repeat(tabSize) : "\t";
  const result: Replacement[] = [];
  nodes.forEach((node, index) => {
    const block = parsed[index];
    if (!block) {
      return;
    }
    const lineStart = source.lastIndexOf("\n", node.keywordStart - 1) + 1;
    const keywordIndent = /^[ \t]*/.exec(source.slice(lineStart, node.keywordStart))?.[0] ?? "";
    const text = renderBlock(block, keywordIndent, unit);
    if (text !== blocks[index].code) {
      result.push({ start: node.bodyStart, end: node.bodyEnd, text });
    }
  });
  return result;
}

/** The text that replaces the body of a block, with one more indentation level than the keyword line. */
export function renderBlock(block: FormattedBlock, keywordIndent: string, unit: string): string {
  const base = keywordIndent + unit;
  const lines = block.lines.map((line) =>
    line.text === "" ? "" : `${base}${unit.repeat(line.levels)}${" ".repeat(line.spaces)}${line.text}`,
  );
  return `\n${lines.join("\n")}\n${keywordIndent}`;
}

/** The .clang-format used when the project has none: tabs of width 2, braces attached, no wrapping, no reordering. */
export const DEFAULT_CLANG_FORMAT = `BasedOnStyle: LLVM
IndentWidth: 2
TabWidth: 2
UseTab: ForIndentation
AlignOperands: DontAlign
ContinuationIndentWidth: 2
ColumnLimit: 0
BreakBeforeBraces: Attach
IndentCaseLabels: true
PointerAlignment: Right
AllowShortFunctionsOnASingleLine: None
AllowShortIfStatementsOnASingleLine: Never
AllowShortLoopsOnASingleLine: false
MaxEmptyLinesToKeep: 1
KeepEmptyLinesAtTheStartOfBlocks: false
SortIncludes: false
ReflowComments: false
`;
