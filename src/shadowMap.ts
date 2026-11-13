import type { Node } from "./parser";

/**
 * Position mapping between the code blocks of a .driver file and the C file indigo_generator produces from it.
 *
 * The generator copies every code block between `//+ id` and `//- id` marker comments, but it re-indents the code
 * and may realign a `#define`, so positions cannot be mapped character by character. Blocks are paired by their
 * whitespace-normalized non-empty lines and positions are mapped line by line, shifting the column by the change of
 * indentation of that line.
 */

export interface Position {
  line: number;
  col: number;
}

interface CodeLine {
  line: number;
  /** Column of the first non-blank character. */
  first: number;
  key: string;
}

interface Block {
  /** First and last line covered by the block, blank lines included. */
  start: number;
  end: number;
  /** Non-blank lines only. */
  lines: CodeLine[];
}

const normalize = (text: string) => text.trim().replace(/\s+/g, " ");

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      starts.push(i + 1);
    }
  }
  return starts;
}

function lineOf(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (starts[mid] <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

/** The non-blank lines of the text between two offsets of a document. */
function driverBlock(text: string, starts: number[], from: number, to: number): Block {
  const start = lineOf(starts, from);
  const end = lineOf(starts, to);
  const lines: CodeLine[] = [];
  for (let line = start; line <= end; line++) {
    const segmentStart = Math.max(starts[line], from);
    const lineEnd = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
    const segment = text.slice(segmentStart, Math.min(lineEnd, to)).replace(/\r$/, "");
    if (segment.trim() !== "") {
      lines.push({
        line,
        first: segmentStart - starts[line] + (segment.length - segment.trimStart().length),
        key: normalize(segment),
      });
    }
  }
  return { start, end, lines };
}

/** The marked blocks of the generated file, in order of appearance. */
/** The marker comments of the generator: `//+ id` before a copied block and `//- id` after it. */
const MARKER = /^\s*\/\/([+-]) ([A-Za-z_][\w.]*)\s*$/;

function generatedBlocks(text: string): Block[] {
  const rows = text.split("\n");
  const open: { id: string; start: number }[] = [];
  const blocks: Block[] = [];
  rows.forEach((row, index) => {
    const marker = MARKER.exec(row.replace(/\r$/, ""));
    if (!marker) {
      return;
    }
    if (marker[1] === "+") {
      open.push({ id: marker[2], start: index + 1 });
      return;
    }
    // A closing marker belongs to the nearest opening one with the same id. Comments of the user that look like
    // markers have no partner, or are dropped here together with whatever was opened after the real one.
    const at = open.map((entry) => entry.id).lastIndexOf(marker[2]);
    if (at < 0) {
      return;
    }
    const { start } = open.splice(at)[0];
    const lines: CodeLine[] = [];
    for (let line = start; line < index; line++) {
      const content = rows[line].replace(/\r$/, "");
      if (content.trim() !== "") {
        lines.push({ line, first: content.length - content.trimStart().length, key: normalize(content) });
      }
    }
    blocks.push({ start, end: index - 1, lines });
  });
  return blocks.sort((a, b) => a.start - b.start);
}

interface Pair {
  driver: Block;
  generated: Block;
}

function mapAcross(from: Block, to: Block, position: Position): Position {
  const exact = from.lines.findIndex((l) => l.line === position.line);
  if (exact >= 0) {
    const a = from.lines[exact];
    const b = to.lines[exact];
    return { line: b.line, col: Math.max(b.first + (position.col - a.first), 0) };
  }
  // A blank line: keep the distance from the nearest mapped line, never leaving the block.
  const before = [...from.lines.keys()].filter((i) => from.lines[i].line < position.line).pop();
  const after = from.lines.findIndex((l) => l.line > position.line);
  let line: number;
  if (before !== undefined) {
    line = to.lines[before].line + (position.line - from.lines[before].line);
    if (after >= 0) {
      line = Math.min(line, to.lines[after].line);
    }
  } else if (after >= 0) {
    line = to.lines[after].line - (from.lines[after].line - position.line);
  } else {
    line = to.start;
  }
  return { line: Math.min(Math.max(line, to.start), to.end), col: 0 };
}

export class ShadowMap {
  constructor(private readonly pairs: Pair[]) {}

  /** Number of driver code blocks that were paired with a generated block. */
  get size(): number {
    return this.pairs.length;
  }

  toGenerated(position: Position): Position | undefined {
    const pair = this.pairs.find((p) => position.line >= p.driver.start && position.line <= p.driver.end);
    return pair && mapAcross(pair.driver, pair.generated, position);
  }

  toDriver(position: Position): Position | undefined {
    const pair = this.pairs.find((p) => position.line >= p.generated.start && position.line <= p.generated.end);
    return pair && mapAcross(pair.generated, pair.driver, position);
  }
}

/** Pair the code nodes of a parsed driver with the marked blocks of its generated C source. */
export function buildShadowMap(driverText: string, codeNodes: Node[], generatedText: string): ShadowMap {
  const starts = lineStarts(driverText);
  const available = codeNodes
    .map((node) => driverBlock(driverText, starts, node.bodyStart, node.bodyEnd))
    .filter((block) => block.lines.length > 0);
  const pairs: Pair[] = [];
  for (const generated of generatedBlocks(generatedText)) {
    if (generated.lines.length === 0) {
      continue;
    }
    const key = generated.lines.map((l) => l.key).join("\n");
    const index = available.findIndex((b) => b.lines.map((l) => l.key).join("\n") === key);
    if (index >= 0) {
      pairs.push({ driver: available.splice(index, 1)[0], generated });
    }
  }
  return new ShadowMap(pairs);
}
