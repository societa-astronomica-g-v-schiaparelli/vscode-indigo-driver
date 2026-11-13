export interface GeneratorMessage {
  line: number;
  column: number;
  message: string;
}

/** Errors reported by indigo_generator as `ERROR (line:column): message`, without the repetitions it emits. */
export function parseGeneratorErrors(output: string): GeneratorMessage[] {
  const seen = new Set<string>();
  const messages: GeneratorMessage[] = [];
  for (const match of output.matchAll(/^ERROR \((\d+):(\d+)\): (.*)$/gm)) {
    if (!seen.has(match[0])) {
      seen.add(match[0]);
      messages.push({ line: Number(match[1]), column: Number(match[2]), message: match[3] });
    }
  }
  return messages;
}

/**
 * Zero based line of a generator error. The generator counts a line as soon as it reads the newline
 * that ends it, so an error reported at column 0 belongs to the previous line.
 */
export function generatorErrorLine(error: GeneratorMessage): number {
  return Math.max(error.column === 0 ? error.line - 2 : error.line - 1, 0);
}
