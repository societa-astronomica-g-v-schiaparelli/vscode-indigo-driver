# INDIGO Driver Definition for VS Code

Language support for the `.driver` definition files used by [INDIGO](https://www.indigo-astronomy.org/) 3 to describe
drivers. A `.driver` file is a small declarative DSL with embedded C code, turned into C sources by `indigo_generator`.

> This is an unofficial community extension. It is not affiliated with or endorsed by the INDIGO project.

## Features

- **Syntax highlighting** of the whole DSL: driver, transports, devices, properties, items, attributes, with the C
  code inside `code`, `on_connect`, `on_change`... blocks highlighted as C. INDIGO helpers (`PRIVATE_DATA`,
  `connection_result`, `INDIGO_*` constants, `*_PROPERTY` / `*_ITEM` macros, `indigo_*()` calls) get their own scopes.
- **Outline and breadcrumbs**: the driver, its devices, properties, items and code blocks, plus code folding of every
  block.
- **Diagnostics while typing**:
  - syntax: unclosed blocks, missing `;`, block comments outside code blocks, unknown statements;
  - structure: missing mandatory attributes, `aux` without `interface`, devices of the same type without `id`,
    unknown attributes, blocks in the wrong place, duplicate attributes and properties;
  - conventions and generator pitfalls: custom property names without the `X_` prefix, labels missing, `return`
    inside `on_connect` / `on_disconnect`, `perm` macros that are not the literal `INDIGO_RO_PERM`, `hidden`
    expressions that the generator silently ignores, `;` inside strings, serial drivers without `<name>_open()` /
    `<name>_close()`.
- **Context aware completion and hover** for blocks, attributes and common values (`perm`, `rule`, `interface`,
  booleans), with the meaning of each attribute.
- **Snippets** for whole drivers (serial and virtual), every device class, properties and items, lifecycle blocks and
  the serial open/close helpers.
- **indigo_generator integration**: run the generator from the editor, see its errors as diagnostics, jump to the generated C file. The generator counts lines
  slightly differently from the editor, so an error inside a multi-line expression can appear a few lines early.

## Requirements

Highlighting, diagnostics, completion and snippets work out of the box. Generating C sources needs the
`indigo_generator` executable, built from the INDIGO repository (`indigo_tools/indigo_generator.c`).

## Commands

| Command                                  | Description                                                      |
| ---------------------------------------- | ---------------------------------------------------------------- |
| `INDIGO Driver: Generate C Sources`      | Save the file and run `indigo_generator` on it                   |
| `INDIGO Driver: Open Generated C Source` | Open `indigo_<type>_<name>.c` (or `.cpp`) next to the definition |

The generator writes `indigo_<type>_<name>.c|.cpp`, `.h` and `_main.c` in the folder of the `.driver` file.

## Settings

| Setting                       | Default | Description                                                                                   |
| ----------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `indigoDriver.generatorPath`  | `""`    | Absolute path to `indigo_generator`, user settings only. When empty it is looked up in `PATH` |
| `indigoDriver.generateOnSave` | `false` | Run the generator every time a `.driver` file is saved                                        |
| `indigoDriver.lint.enable`    | `true`  | Report syntax, structural and semantic problems while typing                                  |

For `.driver` files the extension also sets tab indentation with width 2 and trims trailing whitespace, matching
the INDIGO sources. Override it with the usual `[indigo-driver]` language settings.

## Development

```sh
npm ci
npm run build      # bundle src/extension.ts into dist/extension.cjs
npm run typecheck && npm run lint && npm run format:check
npm test           # Vitest
npm run package    # build a .vsix
```

Press `F5` in VS Code on this folder to start an Extension Development Host after `npm run build`.

The parser mirrors the lexer of `indigo_generator`. To check it against real definitions, point `INDIGO_REPO` to a
checkout of the INDIGO repository: every `.driver` file in it must parse without problems.

```sh
INDIGO_REPO=/path/to/indigo npm test
```

## License

MIT, see the `LICENSE` file. The `NOTICE` file explains the relationship with INDIGO and reports its license for reference.
