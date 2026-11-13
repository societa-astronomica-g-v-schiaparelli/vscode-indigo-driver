import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { generatedSourceName } from "../src/analysis";
import { type Node, parse, walk } from "../src/parser";
import { buildShadowMap } from "../src/shadowMap";

const codeNodes = (root: Node) => {
  const nodes: Node[] = [];
  walk(root, (n) => n.kind === "code" && nodes.push(n));
  return nodes;
};

// The generator re-indents code, realigns #define and adds blank lines around blocks.
const driver = `driver demo {
	code {
		#define POLL 5

		static int twice(int x) {
			return x * 2;
		}
	}
	aux {
		on_connect {
			connection_result = twice(POLL) > 0;
		}
	}
}`;

const generated = `#pragma mark - Code

//+ code

#define POLL                 5

static int twice(int x) {
	return x * 2;
}

//- code

static void connect(void) {
	if (true) {
		//+ aux.on_connect
		connection_result = twice(POLL) > 0;
		//- aux.on_connect
	}
}
`;

describe("buildShadowMap", () => {
  const { root } = parse(driver);
  const map = buildShadowMap(driver, codeNodes(root!), generated);
  const driverLines = driver.split("\n");
  const generatedLines = generated.split("\n");

  it("pairs every non-empty code block", () => {
    expect(map.size).toBe(2);
  });

  it("maps a position on a line whose indentation changed, keeping the same character", () => {
    const line = driverLines.findIndex((l) => l.includes("return x * 2"));
    const col = driverLines[line].indexOf("x * 2");
    const mapped = map.toGenerated({ line, col })!;
    expect(generatedLines[mapped.line].slice(mapped.col, mapped.col + 5)).toBe("x * 2");
  });

  it("maps a block that the generator nested deeper", () => {
    const line = driverLines.findIndex((l) => l.includes("connection_result"));
    const col = driverLines[line].indexOf("twice");
    const mapped = map.toGenerated({ line, col })!;
    expect(generatedLines[mapped.line].slice(mapped.col, mapped.col + 5)).toBe("twice");
  });

  it("maps back to the driver", () => {
    const line = generatedLines.findIndex((l) => l.includes("connection_result"));
    const col = generatedLines[line].indexOf("twice");
    const mapped = map.toDriver({ line, col })!;
    expect(driverLines[mapped.line].slice(mapped.col, mapped.col + 5)).toBe("twice");
  });

  it("maps a blank line inside a block to a line inside the generated block", () => {
    const line = driverLines.findIndex((l) => l.trim() === "") === -1 ? 0 : 3;
    expect(driverLines[line].trim()).toBe("");
    const mapped = map.toGenerated({ line, col: 0 })!;
    expect(generatedLines[mapped.line].trim()).toBe("");
  });

  it("does not map positions outside code blocks", () => {
    expect(map.toGenerated({ line: 0, col: 3 })).toBeUndefined();
    expect(map.toDriver({ line: 0, col: 0 })).toBeUndefined();
  });

  it("is not fooled by user comments that look like markers", () => {
    const text = `driver demo {
	code {
		//+ note
		//------ helpers ------
		static int twice(int x) {
			return x * 2;
		}
		//- end
	}
}`;
    const generatedText = `//+ code

//+ note
//------ helpers ------
static int twice(int x) {
	return x * 2;
}
//- end

//- code
`;
    const { root: parsed } = parse(text);
    const found = buildShadowMap(text, codeNodes(parsed!), generatedText);
    expect(found.size).toBe(1);
    const line = text.split("\n").findIndex((l) => l.includes("return x"));
    const mapped = found.toGenerated({ line, col: 3 + "return ".length })!;
    expect(generatedText.split("\n")[mapped.line].slice(mapped.col, mapped.col + 5)).toBe("x * 2");
  });

  it("leaves unmatched blocks out", () => {
    const edited = driver.replace("twice(POLL) > 0", "twice(POLL) > 1");
    const { root: editedRoot } = parse(edited);
    expect(buildShadowMap(edited, codeNodes(editedRoot!), generated).size).toBe(1);
  });
});

// Set INDIGO_GENERATOR to a built indigo_generator to check the mapping against its real output.
describe.skipIf(!process.env.INDIGO_GENERATOR)("with the real indigo_generator", () => {
  it("pairs every code block of the fixture and maps every character of it", () => {
    const text = readFileSync(new URL("./fixtures/acmeflat.driver", import.meta.url), "utf8");
    const { root } = parse(text);
    const dir = mkdtempSync(join(tmpdir(), "indigo-shadow-"));
    try {
      writeFileSync(join(dir, "acmeflat.driver"), text);
      execFileSync(process.env.INDIGO_GENERATOR!, [join(dir, "acmeflat.driver")], { cwd: dir, stdio: "pipe" });
      const generatedText = readFileSync(join(dir, generatedSourceName(root!)!), "utf8");
      const nodes = codeNodes(root!).filter((n) => text.slice(n.bodyStart, n.bodyEnd).trim() !== "");
      const map = buildShadowMap(text, nodes, generatedText);
      expect(map.size).toBe(nodes.length);

      const generatedLines = generatedText.split("\n");
      let checked = 0;
      for (const node of nodes) {
        for (let offset = node.bodyStart; offset < node.bodyEnd; offset++) {
          const before = text.slice(0, offset).split("\n");
          const line = before.length - 1;
          const col = before[line].length;
          const content = text.split("\n")[line];
          // The generator realigns #define lines, so only their start is comparable.
          if (/\s/.test(text[offset]) || content.trim().startsWith("#define")) {
            continue;
          }
          const mapped = map.toGenerated({ line, col })!;
          expect(generatedLines[mapped.line][mapped.col]).toBe(text[offset]);
          expect(map.toDriver(mapped)).toEqual({ line, col });
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(300);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Needs both INDIGO_GENERATOR and INDIGO_REPO: every real driver must pair all its code blocks.
describe.skipIf(!process.env.INDIGO_GENERATOR || !process.env.INDIGO_REPO)("with the INDIGO drivers", () => {
  const files = process.env.INDIGO_REPO
    ? execFileSync("find", [process.env.INDIGO_REPO, "-name", "*.driver", "!", "-name", "template.driver"])
        .toString()
        .trim()
        .split("\n")
    : [];

  it.each(files)("pairs every code block of %s", (file) => {
    const text = readFileSync(file, "utf8");
    const { root } = parse(text);
    const dir = mkdtempSync(join(tmpdir(), "indigo-shadow-"));
    try {
      writeFileSync(join(dir, "driver.driver"), text);
      execFileSync(process.env.INDIGO_GENERATOR!, [join(dir, "driver.driver")], { cwd: dir, stdio: "pipe" });
      const generatedText = readFileSync(join(dir, generatedSourceName(root!)!), "utf8");
      const nodes = codeNodes(root!).filter((n) => text.slice(n.bodyStart, n.bodyEnd).trim() !== "");
      const map = buildShadowMap(text, nodes, generatedText);
      expect(map.size).toBe(nodes.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
