import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { blockAt, type Node, nodeAt, parse, scanCode, walk } from "../src/parser";

const fixture = readFileSync(new URL("./fixtures/acmeflat.driver", import.meta.url), "utf8");

const messages = (text: string) => parse(text).problems.map((p) => p.message);
const nodes = (root: Node) => {
  const all: Node[] = [];
  walk(root, (n) => all.push(n));
  return all;
};

describe("parse", () => {
  it("reads the structure of a complete driver", () => {
    const { root, problems } = parse(fixture);
    expect(problems).toEqual([]);
    expect(root?.name).toBe("acmeflat");
    const kinds = root!.children.map((c) => `${c.kind}:${c.keyword}`);
    expect(kinds).toEqual([
      "attribute:label",
      "attribute:author",
      "attribute:copyright",
      "attribute:version",
      "transport:serial",
      "code:data",
      "code:code",
      "device:aux",
    ]);
    const aux = root!.children.find((c) => c.kind === "device")!;
    expect(aux.children.filter((c) => c.kind === "property").map((c) => `${c.keyword} ${c.name}`)).toEqual([
      "switch AUX_LIGHT_SWITCH",
      "number AUX_LIGHT_INTENSITY",
      "text X_INFO",
    ]);
  });

  it("accepts bare 'pattern;' and 'item ID;'", () => {
    const all = nodes(parse(fixture).root!);
    expect(all.filter((n) => n.keyword === "pattern")).toHaveLength(2);
    expect(all.find((n) => n.name === "AUX_LIGHT_SWITCH_OFF")?.hasBody).toBe(false);
  });

  it("does not end a code block on braces inside strings and comments", () => {
    const code = nodes(parse(fixture).root!).find((n) => n.keyword === "code")!;
    expect(fixture.slice(code.bodyStart, code.bodyEnd)).toContain("acmeflat_close");
  });

  it("keeps quotes out of string attribute values", () => {
    const label = parse(fixture).root!.children.find((c) => c.keyword === "label")!;
    expect(label.value).toBe("ACME Flat Panel");
    expect(label.isString).toBe(true);
  });

  it("ends an expression at the first semicolon, even inside a string", () => {
    const { root } = parse('driver d { aux { label = "a; b"; } }');
    const label = root!.children[0].children[0];
    expect(label.value).toBe('"a');
  });

  it("reports a missing semicolon before a closing brace", () => {
    expect(messages('driver d { aux { name = "x" } }')).toContain("Missing ';' after the value of 'name'");
  });

  it("reports unclosed blocks", () => {
    expect(messages('driver d { aux { name = "x";')).toContain("Unclosed 'aux' block");
    expect(messages("driver d { code { int x;")).toContain("Unclosed 'code' code block");
  });

  it("rejects block comments outside code blocks but allows them inside", () => {
    expect(messages("driver d { /* no */ }")).toEqual(["Block comments are only allowed inside code blocks: use '//'"]);
    expect(messages("driver d { code { /* ok } */ } }")).toEqual([]);
  });

  it("reports unknown statements and missing equal signs", () => {
    expect(messages("driver d { frobnicate { } }")).toContain("Unknown block or incomplete statement 'frobnicate'");
    expect(messages("driver d { label }")).toContain("Expected '=' after 'label'");
  });

  it("requires the driver keyword and name", () => {
    expect(messages("aux { }")).toContain("Expected 'driver' at the start of the file");
    expect(messages("driver { }")).toContain("Expected the driver name after 'driver'");
  });

  it("accepts bodiless devices and properties", () => {
    expect(messages("driver d { wheel; }")).toEqual([]);
    expect(messages("driver d { wheel { switch X_A; inherited WHEEL_SLOT; } }")).toEqual([]);
  });

  it("types boolean, integer and identifier attributes and makes their semicolon optional", () => {
    expect(messages('driver d { cpp = true\n wheel { inherited A { persistent = true } name = "w"; } }')).toEqual([]);
    expect(messages("driver d { version = 0x10; }").length).toBeGreaterThan(0);
    expect(messages("driver d { version = FOO; }")).toContain("'version' expects a number");
    expect(messages("driver d { wheel { inherited A { persistent = 1; } } }")).toContain(
      "'persistent' expects true or false",
    );
    expect(messages('driver d { wheel { id = "x"; } }')).toContain("'id' expects an identifier");
  });

  it("keeps a closing brace inside a string out of the expression scan", () => {
    expect(messages('driver d { wheel { text X { item Y { label = "}"; } } } }')).toEqual([]);
  });

  it("only accepts ASCII whitespace", () => {
    expect(messages('driver d { wheel {\u00a0name = "w"; } }').length).toBeGreaterThan(0);
  });

  it("reports a block comment between a name and its value once", () => {
    const found = messages('driver d { wheel { name /* c */ = "w"; } }');
    expect(found.filter((m) => m.startsWith("Block comments"))).toHaveLength(1);
  });

  it("gives a partially typed driver a range that covers its name", () => {
    const { root } = parse("driver foo");
    expect(root!.end).toBeGreaterThanOrEqual(root!.nameEnd);
  });

  it("copes with empty input", () => {
    expect(parse("")).toEqual({ root: undefined, problems: [] });
  });
});

describe("scanCode", () => {
  it("finds the matching brace", () => {
    expect(scanCode("a { b } c } d", 0)).toBe("a { b } c ".length);
    expect(scanCode("'}' \"}\" // }\n}", 0)).toBe("'}' \"}\" // }\n".length);
    expect(scanCode("never closed", 0)).toBe(-1);
  });
});

describe("positions", () => {
  const text = fixture;
  const { root } = parse(text);

  it("finds the enclosing block", () => {
    const offset = text.indexOf('label = "Light intensity"');
    expect(blockAt(root!, offset).name).toBe("AUX_LIGHT_INTENSITY");
    expect(blockAt(root!, text.indexOf("interface")).keyword).toBe("aux");
    expect(blockAt(root!, 0)).toBe(root);
  });

  it("finds the node under the cursor", () => {
    const offset = text.indexOf("INDIGO_INTERFACE_AUX_LIGHTBOX") + 3;
    const node = nodeAt(root!, offset);
    expect(node.kind).toBe("attribute");
    expect(node.keyword).toBe("interface");
    expect(nodeAt(root!, text.indexOf("connection_result")).keyword).toBe("on_connect");
  });
});
