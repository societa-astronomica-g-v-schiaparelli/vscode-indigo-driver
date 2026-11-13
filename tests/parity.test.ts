import { describe, expect, it } from "vitest";

import { lint } from "../src/lint";
import { parse } from "../src/parser";

/**
 * Differential cases: the verdicts were recorded by running the real indigo_generator (INDIGO 3.0 series, built from
 * indigo_tools/indigo_generator.c) on each text. "clean" means it printed no error, "problem" that it exited non-zero
 * or printed an ERROR line. The extension must agree on errors: a "clean" text gets no parse problem and no lint
 * error (style warnings are fine), a "problem" text gets at least one parse problem, lint error or lint warning.
 */
const cases: { name: string; verdict: "clean" | "problem"; text: string }[] = [
  {
    name: "baseline",
    verdict: "clean",
    text: 'driver d { label = "L"; author = "A"; copyright = "C"; version = 1;  wheel { name = "w"; } }',
  },
  {
    name: "property_semicolon",
    verdict: "clean",
    text: 'driver d { label = "L"; author = "A"; copyright = "C"; version = 1;  wheel { name = "w"; switch X_A; } }',
  },
  {
    name: "inherited_semicolon",
    verdict: "clean",
    text: 'driver d { label = "L"; author = "A"; copyright = "C"; version = 1;  wheel { name = "w"; inherited WHEEL_SLOT; } }',
  },
  {
    name: "device_semicolon",
    verdict: "clean",
    text: 'driver d { label = "L"; author = "A"; copyright = "C"; version = 1;  wheel; }',
  },
  {
    name: "version_hex",
    verdict: "problem",
    text: 'driver d { label = "L"; author = "A"; copyright = "C"; version = 0x10;  wheel { name = "w"; } }',
  },
  {
    name: "version_ident",
    verdict: "problem",
    text: 'driver d { label = "L"; author = "A"; copyright = "C"; version = FOO;  wheel { name = "w"; } }',
  },
  {
    name: "persistent_1",
    verdict: "problem",
    text: 'driver d { label = "L"; author = "A"; copyright = "C"; version = 1;  wheel { name = "w"; inherited WHEEL_SLOT { persistent = 1; } } }',
  },
  {
    name: "id_string",
    verdict: "problem",
    text: 'driver d { label = "L"; author = "A"; copyright = "C"; version = 1;  wheel { id = "x"; name = "w"; } }',
  },
  {
    name: "cpp_no_semicolon",
    verdict: "clean",
    text: 'driver d { label = "L"; author = "A"; copyright = "C"; version = 1; cpp = true\n wheel { name = "w"; } }',
  },
  {
    name: "bool_no_semicolon_in_dev",
    verdict: "clean",
    text: 'driver d { label = "L"; author = "A"; copyright = "C"; version = 1;  wheel { name = "w"; inherited WHEEL_SLOT { persistent = true } } }',
  },
  {
    name: "string_no_semicolon",
    verdict: "clean",
    text: 'driver d { label = "L" author = "A"; copyright = "C"; version = 1;  wheel { name = "w"; } }',
  },
  {
    name: "brace_in_string",
    verdict: "clean",
    text: 'driver d { label = "L"; author = "A"; copyright = "C"; version = 1;  wheel { name = "w"; text X_A { name = "X_A"; label = "A"; item X_B { label = "}"; } } } }',
  },
  {
    name: "nbsp",
    verdict: "problem",
    text: 'driver d { label = "L"; author = "A"; copyright = "C"; version = 1;  wheel {\u00a0name = "w";  } }',
  },
  {
    name: "block_comment_mid",
    verdict: "problem",
    text: 'driver d { label = "L"; author = "A"; copyright = "C"; version = 1;  wheel { name = "w"; name /* c */ = "w"; } }',
  },
  {
    name: "reject_no_condition",
    verdict: "problem",
    text: 'driver d { label = "L"; author = "A"; copyright = "C"; version = 1;  wheel { name = "w"; inherited WHEEL_SLOT { reject_change { message = "m"; } on_change { } } } }',
  },
  {
    name: "reject_ok",
    verdict: "clean",
    text: 'driver d { label = "L"; author = "A"; copyright = "C"; version = 1;  wheel { name = "w"; inherited WHEEL_SLOT { reject_change { condition = true; message = "m"; } on_change { } } } }',
  },
  {
    name: "reject_no_branch",
    verdict: "problem",
    text: 'driver d { label = "L"; author = "A"; copyright = "C"; version = 1;  wheel { name = "w"; inherited WHEEL_SLOT { reject_change { condition = true; message = "m"; } } } }',
  },
  {
    name: "reject_ro",
    verdict: "problem",
    text: 'driver d { label = "L"; author = "A"; copyright = "C"; version = 1;  wheel { name = "w"; text X_A { name = "X_A"; label = "A"; perm = INDIGO_RO_PERM; reject_change { condition = true; message = "m"; } item X_B { label = "b"; } } } }',
  },
  {
    name: "id_after_props",
    verdict: "problem",
    text: 'driver d { label = "L"; author = "A"; copyright = "C"; version = 1;  wheel { name = "w"; inherited WHEEL_SLOT { } id = foo; } }',
  },
  {
    name: "dup_ids",
    verdict: "problem",
    text: 'driver d { label = "L"; author = "A"; copyright = "C"; version = 1;  aux { id = a; name = "x"; interface = INDIGO_INTERFACE_AUX_GPIO; } aux { id = a; name = "y"; interface = INDIGO_INTERFACE_AUX_GPIO; } }',
  },
  {
    name: "id_equals_type",
    verdict: "problem",
    text: 'driver d { label = "L"; author = "A"; copyright = "C"; version = 1;  wheel { id = aux; name = "w"; } aux { name = "x"; interface = INDIGO_INTERFACE_AUX_GPIO; } }',
  },
  {
    name: "max_devices_0",
    verdict: "problem",
    text: 'driver d { label = "L"; author = "A"; copyright = "C"; version = 1; max_devices = 0; libusb { } wheel { name = "w"; } }',
  },
  {
    name: "min_on_text_item",
    verdict: "problem",
    text: 'driver d { label = "L"; author = "A"; copyright = "C"; version = 1;  wheel { name = "w"; text X_A { name = "X_A"; label = "A"; item X_B { label = "b"; min = 1; } } } }',
  },
  {
    name: "min_on_number_item",
    verdict: "clean",
    text: 'driver d { label = "L"; author = "A"; copyright = "C"; version = 1;  wheel { name = "w"; number X_A { name = "X_A"; label = "A"; item X_B { label = "b"; min = 1; } } } }',
  },
  {
    name: "multiline_expr",
    verdict: "clean",
    text: 'driver d { label = "L"; author = "A"; copyright = "C"; version = 1; DEF = a +\n b; wheel { name = "w"; } }',
  },
  {
    name: "pattern_semicolon",
    verdict: "clean",
    text: 'driver d { label = "L"; author = "A"; copyright = "C"; version = 1; serial { pattern; } wheel { name = "w"; } }',
  },
  {
    name: "libusb_semicolon",
    verdict: "clean",
    text: 'driver d { label = "L"; author = "A"; copyright = "C"; version = 1; libusb; wheel { name = "w"; } }',
  },
  {
    name: "perm_property_macro",
    verdict: "clean",
    text: 'driver d { label = "L"; author = "A"; copyright = "C"; version = 1;  wheel { name = "w"; inherited WHEEL_SLOT { perm = MY_PROPERTY_PERM; } } }',
  },
];

const findings = (text: string, severities: string[]) => {
  const { root, problems } = parse(text);
  const found = root ? lint(root, text) : [];
  return [...problems, ...found.filter((p) => severities.includes(p.severity))].map((p) => p.message);
};

describe("agreement with indigo_generator", () => {
  it.each(cases)("$name is $verdict", ({ text, verdict }) => {
    if (verdict === "clean") {
      expect(findings(text, ["error"])).toEqual([]);
    } else {
      expect(findings(text, ["error", "warning"]).length).toBeGreaterThan(0);
    }
  });
});
