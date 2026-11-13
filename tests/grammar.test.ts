import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";
import { createOnigScanner, createOnigString, loadWASM } from "vscode-oniguruma";
import { INITIAL, parseRawGrammar, Registry } from "vscode-textmate";

const require = createRequire(import.meta.url);
const read = (path: string) => readFileSync(path, "utf8");

await loadWASM(readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm")).buffer as ArrayBuffer);

const registry = new Registry({
  onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
  loadGrammar: async (scopeName) => {
    const path =
      scopeName === "source.indigo-driver"
        ? new URL("../syntaxes/indigo-driver.tmLanguage.json", import.meta.url).pathname
        : scopeName === "source.c"
          ? require.resolve("tm-grammars/grammars/c.json")
          : undefined;
    return path ? parseRawGrammar(read(path), path) : null;
  },
});
const grammar = (await registry.loadGrammar("source.indigo-driver"))!;

/** Scopes of the first token whose text equals `word` on any line. */
function scopesOf(source: string, word: string): string[] {
  let state = INITIAL;
  for (const line of source.split("\n")) {
    const { tokens, ruleStack } = grammar.tokenizeLine(line, state);
    for (const token of tokens) {
      if (line.slice(token.startIndex, token.endIndex) === word) {
        return token.scopes;
      }
    }
    state = ruleStack;
  }
  throw new Error(`token '${word}' not found`);
}

const source = `driver demo {
	label = "Demo";
	version = 3;
	serial {
		pattern { vid = 0x0403; }
		pattern;
	}
	code {
		static bool demo_open(indigo_device *device) {
			return PRIVATE_DATA->handle != NULL; // }
		}
	}
	aux {
		name = "Demo";
		interface = INDIGO_INTERFACE_AUX_GPIO;
		switch X_MODE {
			name = "X_MODE";
			hidden = true;
			on_change {
				indigo_update_property(device, X_MODE_PROPERTY, NULL);
			}
			item X_MODE_ON;
		}
	}
}`;

describe("grammar", () => {
  it("scopes the structure", () => {
    expect(scopesOf(source, "driver")).toContain("storage.type.driver.indigo-driver");
    expect(scopesOf(source, "demo")).toContain("entity.name.type.driver.indigo-driver");
    expect(scopesOf(source, "serial")).toContain("storage.type.transport.indigo-driver");
    expect(scopesOf(source, "aux")).toContain("storage.type.device.indigo-driver");
    expect(scopesOf(source, "switch")).toContain("storage.type.property.indigo-driver");
    expect(scopesOf(source, "X_MODE")).toContain("entity.name.function.custom-property.indigo-driver");
    expect(scopesOf(source, "item")).toContain("storage.type.item.indigo-driver");
    expect(scopesOf(source, "on_change")).toContain("keyword.control.code-block.indigo-driver");
  });

  it("scopes attributes and their values", () => {
    expect(scopesOf(source, "label")).toContain("variable.other.attribute.indigo-driver");
    expect(scopesOf(source, '"Demo"')).toContain("string.quoted.double.indigo-driver");
    expect(scopesOf(source, "0x0403")).toContain("constant.numeric.indigo-driver");
    expect(scopesOf(source, "true")).toContain("constant.language.boolean.indigo-driver");
    expect(scopesOf(source, "INDIGO_INTERFACE_AUX_GPIO")).toContain("support.constant.indigo.indigo-driver");
  });

  it("embeds C in code blocks", () => {
    expect(scopesOf(source, "static")).toContain("meta.embedded.block.c");
    expect(scopesOf(source, "static")).toContain("storage.modifier.c");
    expect(scopesOf(source, "indigo_update_property")).toContain("support.function.indigo.indigo-driver");
    expect(scopesOf(source, "PRIVATE_DATA")).toContain("variable.language.indigo-driver");
  });

  it("handles bodiless forms and a missing semicolon before a closing brace", () => {
    const text = `driver d {
	label = "Demo";
	libusb;
	wheel;
	aux {
		switch X_A;
		name = "x"
	}
	ccd { }
}`;
    expect(scopesOf(text, "libusb")).toContain("storage.type.transport.indigo-driver");
    expect(scopesOf(text, "wheel")).toContain("storage.type.device.indigo-driver");
    expect(scopesOf(text, "X_A")).toContain("entity.name.function.property.indigo-driver");
    // The attribute without ';' before '}' must not swallow the closing braces: 'ccd' is a device at driver level again.
    const scopes = scopesOf(text, "ccd");
    expect(scopes).toContain("storage.type.device.indigo-driver");
    expect(scopes).not.toContain("meta.attribute.indigo-driver");
  });

  it("does not leak the embedded C past the closing brace", () => {
    // 'aux' follows the code block: it must be a device again, outside the embedded C scope.
    expect(scopesOf(source, "aux")).not.toContain("meta.embedded.block.c");
    expect(scopesOf(source, "interface")).toContain("variable.other.attribute.indigo-driver");
  });
});
