/** A stand-in formatter: four spaces per brace level, preprocessor lines at column 0, blank lines collapsed. */
export function naiveFormat(text: string): string {
  let depth = 0;
  let blank = false;
  const out: string[] = [];
  for (const row of text.split("\n")) {
    const line = row.trim();
    if (line === "") {
      blank = out.length > 0;
      continue;
    }
    if (blank) {
      out.push("");
      blank = false;
    }
    if (line.startsWith("}")) {
      depth = Math.max(depth - 1, 0);
    }
    out.push(line.startsWith("#") ? line : `${"    ".repeat(depth)}${line}`);
    depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0) + (line.startsWith("}") ? 1 : 0);
  }
  return `${out.join("\n")}\n`;
}
