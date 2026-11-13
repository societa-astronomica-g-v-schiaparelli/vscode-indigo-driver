import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildScratch, DEFAULT_CLANG_FORMAT, formattedReplacements } from "../src/formatCode";
import { type Node, parse, walk } from "../src/parser";
import { naiveFormat } from "./helpers";

function format(text: string, formatter: (scratch: string) => string, tabSize = 2, insertSpaces = false): string {
  const { root } = parse(text);
  const nodes: Node[] = [];
  walk(root!, (n) => n.kind === "code" && text.slice(n.bodyStart, n.bodyEnd).trim() !== "" && nodes.push(n));
  const blocks = nodes.map((n) => ({ keyword: n.keyword, code: text.slice(n.bodyStart, n.bodyEnd) }));
  const replacements = formattedReplacements(text, nodes, formatter(buildScratch(blocks)), tabSize, insertSpaces);
  return replacements.reduceRight((acc, r) => acc.slice(0, r.start) + r.text + acc.slice(r.end), text);
}

const fixture = readFileSync(new URL("./fixtures/acmeflat.driver", import.meta.url), "utf8");

describe("buildScratch", () => {
  it("wraps statements in a function, data in a struct and leaves declarations bare", () => {
    const scratch = buildScratch([
      { keyword: "on_connect", code: "\n\t\tfoo();\n\t" },
      { keyword: "data", code: "int a;" },
      { keyword: "code", code: "#define X 1" },
    ]);
    expect(scratch).toContain("void __indigo_block_0(void) {\n\t\tfoo();\n}");
    expect(scratch).toContain("struct __indigo_data_1 {\nint a;\n};");
    expect(scratch).toContain("//@indigo-block 2\n#define X 1\n");
    expect(scratch.startsWith("void __indigo_probe(void) {")).toBe(true);
  });
});

describe("formatting code blocks", () => {
  it("leaves a well formatted driver untouched", () => {
    expect(format(fixture, naiveFormat)).toBe(fixture);
  });

  it("fixes indentation, keeping the position of the block", () => {
    const messy = `driver d {
	wheel {
		on_connect {
foo();
	if (x) {
bar();
		}
		}
	}
}`;
    expect(format(messy, naiveFormat)).toBe(`driver d {
	wheel {
		on_connect {
			foo();
			if (x) {
				bar();
			}
		}
	}
}`);
  });

  it("expands a one line block", () => {
    expect(format("driver d {\n\twheel {\n\t\ton_connect { foo(); }\n\t}\n}", naiveFormat)).toBe(
      "driver d {\n\twheel {\n\t\ton_connect {\n\t\t\tfoo();\n\t\t}\n\t}\n}",
    );
  });

  it("formats data members and top level declarations", () => {
    const messy = "driver d {\n\tdata {\nint a;\n\t}\n\tcode {\nstatic void f(void) {\nint b;\n}\n\t}\n}";
    expect(format(messy, naiveFormat)).toBe(
      "driver d {\n\tdata {\n\t\tint a;\n\t}\n\tcode {\n\t\tstatic void f(void) {\n\t\t\tint b;\n\t\t}\n\t}\n}",
    );
  });

  it("indents with spaces when the editor does", () => {
    expect(format("driver d {\n\twheel {\n\t\ton_connect { foo(); }\n\t}\n}", naiveFormat, 4, true)).toContain(
      "\n\t\t    foo();\n",
    );
  });

  it("is idempotent", () => {
    const once = format("driver d {\n\twheel {\n\t\ton_connect {\nfoo();\nif (x) {\nbar();\n}\n}\n\t}\n}", naiveFormat);
    expect(format(once, naiveFormat)).toBe(once);
  });

  it("keeps the lines of a block comment where the author put them relative to its first line", () => {
    const text = `driver d {
	wheel {
		on_connect {
			/* first line
					 aligned text
			 */
			foo();
		}
	}
}`;
    // naiveFormat flattens the comment lines, which is what a real formatter does to a degree.
    expect(format(text, naiveFormat)).toBe(text);
  });

  it("keeps the code of an #if 0 region relative to the #if 0 line", () => {
    const text = `driver d {
	wheel {
		on_connect {
			foo();
			#if 0
						skipped();
			#endif
		}
	}
}`;
    expect(format(text, naiveFormat)).toBe(text);
  });

  it("leaves a block alone when the formatter destroyed its wrapper", () => {
    const text = "driver d {\n\twheel {\n\t\ton_connect {\nfoo();\n\t\t}\n\t}\n}";
    expect(format(text, () => "nothing useful")).toBe(text);
  });
});

// Set CLANG_FORMAT to a clang-format executable to check the whole pipeline with the real formatter. With
// INDIGO_REPO as well, every real driver must come back stable.
describe.skipIf(!process.env.CLANG_FORMAT)("with clang-format", () => {
  const clang = (scratch: string) => {
    const dir = mkdtempSync(join(tmpdir(), "indigo-clang-"));
    try {
      writeFileSync(join(dir, ".clang-format"), DEFAULT_CLANG_FORMAT);
      writeFileSync(join(dir, "scratch.c"), scratch);
      return execFileSync(process.env.CLANG_FORMAT!, ["-style=file", join(dir, "scratch.c")], { cwd: dir }).toString();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("keeps the fixture as it is", () => {
    expect(format(fixture, clang)).toBe(fixture);
  });

  it("formats badly indented code and stays stable", () => {
    const messy = `driver d {
	wheel {
		on_connect {
foo(1,2);
if(x){
bar( );
}
		}
	}
}`;
    const once = format(messy, clang);
    expect(once).toContain("\t\t\tfoo(1, 2);\n\t\t\tif (x) {\n\t\t\t\tbar();\n\t\t\t}\n");
    expect(format(once, clang)).toBe(once);
  });

  describe.skipIf(!process.env.INDIGO_REPO)("with the INDIGO drivers", () => {
    const files = process.env.INDIGO_REPO
      ? execFileSync("find", [process.env.INDIGO_REPO, "-name", "*.driver", "!", "-name", "template.driver"])
          .toString()
          .trim()
          .split("\n")
      : [];

    it.each(files)("formats %s into a stable, valid definition", (file) => {
      const once = format(readFileSync(file, "utf8"), clang);
      expect(parse(once).problems).toEqual([]);
      expect(format(once, clang)).toBe(once);
    });
  });
});
