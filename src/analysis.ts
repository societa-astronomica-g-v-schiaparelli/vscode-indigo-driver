import { lint } from "./lint";
import { type Node, parse, type Problem } from "./parser";

export interface Analysis {
  root?: Node;
  /** Syntax problems reported by the parser. */
  syntax: Problem[];
  /** Structural and semantic findings. */
  semantic: Problem[];
}

export function analyze(text: string): Analysis {
  const { root, problems } = parse(text);
  return { root, syntax: problems, semantic: root ? lint(root, text) : [] };
}

/** Path of the C or C++ file the generator writes next to the definition. */
export function generatedSourceName(root: Node): string | undefined {
  const device = root.children.find((child) => child.kind === "device");
  if (!device || !root.name) {
    return undefined;
  }
  const cpp = root.children.find((child) => child.kind === "attribute" && child.keyword === "cpp");
  return `indigo_${device.keyword}_${root.name}.${cpp?.value === "true" ? "cpp" : "c"}`;
}
