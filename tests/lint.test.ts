import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { lint, stripCode } from "../src/lint";
import { parse } from "../src/parser";

const fixture = readFileSync(new URL("./fixtures/acmeflat.driver", import.meta.url), "utf8");

const check = (text: string) => {
  const { root } = parse(text);
  return lint(root!, text).map((p) => `${p.severity}: ${p.message}`);
};

const HEADER = 'label = "L"; author = "A"; copyright = "C"; version = 1;';
const driver = (body: string) => `driver demo { ${HEADER} ${body} }`;

describe("lint", () => {
  it("accepts the complete fixture", () => {
    expect(check(fixture)).toEqual([]);
  });

  it("requires the mandatory driver attributes and a device", () => {
    const found = check('driver demo { label = "L"; }');
    expect(found).toContain("error: Missing mandatory attribute 'author'");
    expect(found).toContain("error: Missing mandatory attribute 'copyright'");
    expect(found).toContain("error: Missing mandatory attribute 'version'");
    expect(found).toContain("error: At least one device block is required");
  });

  it("flags driver names that are not lower case identifiers", () => {
    expect(check(fixture.replace("driver acmeflat", "driver AcmeFlat"))).toContain(
      "warning: Driver names are lower case, start with a letter and use only [a-z0-9_]",
    );
  });

  it("flags version 0", () => {
    expect(
      check(driver('aux { name = "x"; interface = INDIGO_INTERFACE_AUX_GPIO; }').replace("version = 1", "version = 0")),
    ).toContain("warning: Driver version must not be 0");
  });

  it("requires an interface on aux devices and a name on every device", () => {
    const found = check(driver("aux { }"));
    expect(found).toContain("error: 'aux' devices require an 'interface' (INDIGO_INTERFACE_AUX_*)");
    expect(found).toContain("warning: Set the device 'name' seen by clients");
  });

  it("requires ids when two devices share a type", () => {
    const found = check(driver('ccd { name = "a"; } ccd { name = "b"; }'));
    expect(found).toContain("error: Duplicate device id 'ccd': give each device of the same type a distinct 'id'");
    expect(check(driver('ccd { name = "a"; } ccd { id = other; name = "b"; }'))).toEqual([]);
  });

  it("flags duplicate effective device ids, including an id equal to another device type", () => {
    const aux = 'aux { name = "x"; interface = INDIGO_INTERFACE_AUX_GPIO; }';
    expect(check(driver(`wheel { id = aux; name = "w"; } ${aux}`))).toContain(
      "error: Duplicate device id 'aux': give each device of the same type a distinct 'id'",
    );
  });

  it("requires the device id before properties and code", () => {
    expect(check(driver('wheel { name = "w"; code { } id = other; }'))).toContain(
      "error: Device 'id' must precede properties and code blocks",
    );
  });

  it("requires reject_change conditions and flags reject_change without a change branch", () => {
    const withBranch = 'inherited WHEEL_SLOT { reject_change { message = "m"; } on_change { } }';
    expect(check(driver(`wheel { name = "w"; ${withBranch} }`))).toContain(
      "error: Missing mandatory attribute 'condition'",
    );
    const ignored = 'inherited WHEEL_SLOT { reject_change { condition = true; message = "m"; } }';
    expect(check(driver(`wheel { name = "w"; ${ignored} }`))).toContain(
      "warning: This property has no change branch: its reject_change block is ignored",
    );
  });

  it("limits min, max, step and format to number items and max_devices to positive values", () => {
    const item = 'text X_A { name = "X_A"; label = "A"; item X_B { label = "b"; min = 1; } }';
    expect(check(driver(`wheel { name = "w"; ${item} }`))).toContain(
      "error: 'min' is only valid on items of number properties",
    );
    expect(check(driver('max_devices = 0; wheel { name = "w"; }'))).toContain("error: max_devices must be at least 1");
  });

  it("does not mistake property-like macros for read-only permissions", () => {
    expect(check(driver('wheel { name = "w"; inherited WHEEL_SLOT { perm = MY_PROPERTY_PERM; } }'))).toEqual([]);
  });

  it("checks custom property names, labels and hidden", () => {
    const found = check(driver('wheel { name = "w"; text FOO { name = "FOO"; hidden = flag; item V { } } }'));
    expect(found).toContain(
      "warning: Custom property names should start with 'X_'; standard properties use their *_PROPERTY_NAME macro",
    );
    expect(found).toContain("warning: Set a 'label' on every local property");
    expect(found).toContain("warning: Set a 'label' on every item");
    expect(found).toContain(
      "warning: On local properties only a literal 'true' hides the property; an expression is silently ignored",
    );
  });

  it("warns about permission macros that are not the RO literal", () => {
    expect(check(driver('wheel { name = "w"; inherited WHEEL_SLOT { perm = MY_RO_PERM; } }'))).toContain(
      "warning: Write exactly 'INDIGO_RO_PERM' to drop the generated change branch",
    );
  });

  it("flags unknown attributes and blocks that do not belong", () => {
    const found = check(driver('wheel { name = "w"; speed = 3; inherited WHEEL_SLOT { item X { } } }'));
    expect(found).toContain("warning: Unknown attribute 'speed' for 'wheel'");
    expect(found).toContain("warning: 'item' is not valid inside 'inherited'");
  });

  it("accepts driver level constants", () => {
    expect(check(driver('POLL_INTERVAL = 5; wheel { name = "w"; }'))).toEqual([]);
  });

  it("flags duplicates", () => {
    expect(check(driver('wheel { name = "w"; name = "x"; }'))).toContain("warning: Duplicate attribute 'name'");
    expect(check(driver('wheel { name = "w"; inherited WHEEL_SLOT { } inherited WHEEL_SLOT { } }'))).toContain(
      "warning: Property 'WHEEL_SLOT' is declared more than once",
    );
  });

  it("flags return in connection blocks, but not inside strings or comments", () => {
    const body = (code: string) => driver(`wheel { name = "w"; on_connect { ${code} } }`);
    expect(check(body("return;"))).toContain(
      "warning: Never 'return' in on_connect: it skips property definition, messages and the CONNECTION update",
    );
    expect(check(body('const char *s = "return"; // return'))).toEqual([]);
  });

  it("hints about finalizers in on_change", () => {
    const text = driver(
      'wheel { name = "w"; inherited WHEEL_SLOT { on_change { indigo_set_timer(device, 1, slot_finalizer, NULL); } } }',
    );
    expect(check(text).some((m) => m.startsWith("hint:"))).toBe(true);
  });

  it("requires open and close in serial drivers unless a local header provides them", () => {
    const serial = driver('serial { } wheel { name = "w"; }');
    expect(check(serial)).toContain("warning: Serial drivers need demo_open() in the driver 'code' block");
    expect(check(serial)).toContain("warning: Serial drivers need demo_close() in the driver 'code' block");
    expect(check(driver('serial { } define { #include "shared.h" } wheel { name = "w"; }'))).toEqual([]);
  });

  it("flags unbalanced quotes but not escaped ones", () => {
    expect(check(driver('wheel { name = "w"; label = "a; b"; }'))).toContain(
      "warning: Unbalanced quote: the generator ends the value at the first ';', even inside a string",
    );
    expect(check(driver('wheel { name = "w"; inherited WHEEL_SLOT { label = "2\\""; } }'))).toEqual([]);
  });
});

describe("stripCode", () => {
  it("blanks strings, characters and comments but keeps offsets", () => {
    const code = "a(\"x;y\", '}'); /* c */ // d\nb";
    const stripped = stripCode(code);
    expect(stripped).toHaveLength(code.length);
    expect(stripped).toBe(`a(${" ".repeat(5)},${" ".repeat(4)});${" ".repeat(13)}\nb`);
  });
});
