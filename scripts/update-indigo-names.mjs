// Refresh the INDIGO enumerators and type names used to color C code blocks.
//
//   node scripts/update-indigo-names.mjs /path/to/indigo/indigo_libs/indigo
//
// The folder is the one with the INDIGO headers (indigo_bus.h and friends). The lists are written into
// syntaxes/indigo-driver.tmLanguage.json.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { URL } from "node:url";

const directory = process.argv[2];
if (!directory) {
  process.stderr.write("usage: node scripts/update-indigo-names.mjs <folder with the INDIGO headers>\n");
  process.exit(1);
}

const enumerators = new Set();
const types = new Set();
for (const name of readdirSync(directory).filter((file) => file.endsWith(".h"))) {
  const text = readFileSync(join(directory, name), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  for (const block of text.matchAll(/enum\s*\w*\s*\{([^}]*)\}/g)) {
    for (const item of block[1].split(",")) {
      const found = /^\s*([A-Z][A-Z0-9_]*)\b/.exec(item);
      if (found) {
        enumerators.add(found[1]);
      }
    }
  }
  // A typedef runs to the first ';' outside braces, and its name is the last word. Function pointers end in ')'.
  for (const start of text.matchAll(/\btypedef\b/g)) {
    let depth = 0;
    for (let i = start.index; i < text.length; i++) {
      if (text[i] === "{") {
        depth++;
      } else if (text[i] === "}") {
        depth--;
      } else if (text[i] === ";" && depth === 0) {
        const name = /(\w+)\s*$/.exec(text.slice(start.index, i));
        if (name && !text.slice(start.index, i).trimEnd().endsWith(")")) {
          types.add(name[1]);
        }
        break;
      }
    }
  }
}

// Names ending in _t are colored by a general rule.
const typeNames = [...types].filter((type) => /^[a-z]/.test(type) && !type.endsWith("_t")).sort();
const alternation = (names) => `\\b(?:${[...names].sort().join("|")})\\b`;

const path = new URL("../syntaxes/indigo-driver.tmLanguage.json", import.meta.url);
const grammar = JSON.parse(readFileSync(path, "utf8"));
grammar.repository["indigo-enumerators"].match = alternation(enumerators);
grammar.repository["indigo-types"].patterns[0].match = alternation(typeNames);
writeFileSync(path, `${JSON.stringify(grammar, null, 2)}\n`);
process.stdout.write(`${enumerators.size} enumerators, ${typeNames.length} types\n`);
