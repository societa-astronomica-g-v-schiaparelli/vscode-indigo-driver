import { describe, expect, it } from "vitest";

import { analyze, generatedSourceName } from "../src/analysis";
import { generatorErrorLine, parseGeneratorErrors } from "../src/generatorOutput";

describe("parseGeneratorErrors", () => {
  it("extracts positions and messages", () => {
    const output =
      "Reading x.driver ...\nERROR (12:5): Unexpected token '}'\nERROR (40:1): Unsupported byte 0x2F\n\nFailed to parse definition file\n";
    expect(parseGeneratorErrors(output)).toEqual([
      { line: 12, column: 5, message: "Unexpected token '}'" },
      { line: 40, column: 1, message: "Unsupported byte 0x2F" },
    ]);
  });

  it("drops the repeated errors the generator prints", () => {
    const output =
      "Reading b.driver ...\nERROR (4:10): Failed to parse C expression\nERROR (4:10): Unexpected token NONE\nERROR (4:10): Unexpected token NONE\n";
    expect(parseGeneratorErrors(output).map((e) => e.message)).toEqual([
      "Failed to parse C expression",
      "Unexpected token NONE",
    ]);
  });

  it("returns nothing for a clean run", () => {
    expect(parseGeneratorErrors("Reading x.driver ...\nWriting indigo_aux_x.h ...\n")).toEqual([]);
  });
});

describe("generatedSourceName", () => {
  it("derives the C file from the first device and the driver name", () => {
    const { root } = analyze('driver acme { aux { name = "x"; } ccd { id = c; name = "y"; } }');
    expect(generatedSourceName(root!)).toBe("indigo_aux_acme.c");
  });

  it("uses .cpp when requested", () => {
    const { root } = analyze('driver acme { cpp = true; ccd { name = "x"; } }');
    expect(generatedSourceName(root!)).toBe("indigo_ccd_acme.cpp");
  });

  it("needs a device", () => {
    const { root } = analyze("driver acme { }");
    expect(generatedSourceName(root!)).toBeUndefined();
  });
});

describe("generatorErrorLine", () => {
  it("maps a mid-line error to its zero based line", () => {
    expect(generatorErrorLine({ line: 12, column: 5, message: "" })).toBe(11);
  });

  it("maps a column 0 error to the previous line, as the generator counts a line when it reads its newline", () => {
    // `version = 0x10;` on line 3 is reported as 4:0
    expect(generatorErrorLine({ line: 4, column: 0, message: "" })).toBe(2);
  });

  it("never goes below the first line", () => {
    expect(generatorErrorLine({ line: 1, column: 0, message: "" })).toBe(0);
  });
});
