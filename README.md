# INDIGO Driver Definition for VS Code

Language support for the `.driver` definition files used by [INDIGO](https://www.indigo-astronomy.org/) 3 to describe
drivers. A `.driver` file is a small declarative DSL with embedded C code, turned into C sources by `indigo_generator`.

> This is an unofficial community extension. It is not affiliated with or endorsed by the INDIGO project.

## Features

- **Syntax highlighting** of the whole DSL: driver, transports, devices, properties, items, attributes, with the C
  code inside `code`, `on_connect`, `on_change`... blocks highlighted as C. The INDIGO vocabulary is recognized by name,
  without a language server: enumerators (`INDIGO_OK_STATE`, `INDIGO_INTERFACE_*`...), other capitalized macros
  (`PRIVATE_DATA`, `*_PROPERTY`, `*_ITEM`), INDIGO and `*_t` types, `indigo_*()` calls, `connection_result` and the
  `device` parameter each get the scope that themes use for them.
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
- **C language features inside code blocks** (opt-in): completion, hover, go to definition (also into the INDIGO
  headers and between code blocks) and signature help, provided by the C/C++ extension. See below.
- **Formatting** of the C code blocks (_Format Document_, _Format Selection_, format on save) with the C/C++ formatter
  of VS Code. See below.
- **indigo_generator integration**: run the generator from the editor, see its errors as diagnostics, jump to the generated C file. The generator counts lines
  slightly differently from the editor, so an error inside a multi-line expression can appear a few lines early.

## Requirements

Highlighting, diagnostics, completion and snippets work out of the box. Generating C sources needs the
`indigo_generator` executable, built from the INDIGO repository (`indigo_tools/indigo_generator.c`).

## C language features in code blocks

Turn on `indigoDriver.cLanguageFeatures` to get the usual C editing inside `code`, `on_connect`, `on_change`... blocks.
The extension keeps a generated copy of the driver in its storage folder, regenerated with `indigo_generator` whenever
the file changed, and asks the C/C++ extension (Microsoft C/C++, the VS Code default) about it. Answers are mapped
back to the `.driver` file. Because the copy is the real generated source, `PRIVATE_DATA`, the `*_PROPERTY` and
`*_ITEM` macros and the helpers of other code blocks are all known.

- Needs `indigo_generator` (see Requirements) and the C/C++ extension (`ms-vscode.cpptools`).
- INDIGO headers in `/usr/include` and `/usr/local/include` are found by the C/C++ extension on its own. Nothing is
  configured and no setting is written for that.
- Headers elsewhere: list their directories in `indigoDriver.includePaths`. The C/C++ extension only listens to
  them once INDIGO Driver is its configuration provider, so run **INDIGO Driver: Use as C/C++ Configuration
  Provider**. The command writes `C_Cpp.default.configurationProvider` to the _workspace_ settings (it asks before
  replacing another provider, such as CMake Tools) and nothing else; **Stop Using as C/C++ Configuration Provider**
  removes it. The extension never changes that setting by itself, and answers only for its own generated files.
  The folder of the `.driver` file is added too, for `#include "..."`.
- While the definition has a syntax error, or `indigo_generator` fails on it, the C features pause until it is fixed.
- Right after an edit the C/C++ extension needs a moment to analyze the new generated file, so the first request
  waits for it (up to 15 seconds, and not at all if it never answers). When the features do nothing, the _INDIGO
  Driver_ output channel says why: the option is off, the workspace is untrusted, the definition has syntax errors, or
  the generator is missing or failed.
- The generated copies live in the extension storage folder (`.../User/globalStorage/<publisher>.indigo-driver/` in the
  VS Code data directory): `shadow/` holds, for each `.driver` file, the generator output and at most one generated C
  file at a time, and `format/` the scratch files of the formatter. Files not touched for 30 days are removed when the
  extension starts.

## Formatting

_Format Document_ and _Format Selection_ format the C code blocks with the formatter of the C/C++ extension
(clang-format), and keep the block where it is in the file. The structure of the definition itself is not changed.

- The style comes from the nearest `.clang-format` above the `.driver` file. Without one, a built-in style is used:
  tabs of width 2, attached braces, no line wrapping, no reordering of `#include`.
- Indentation follows the editor settings of the file (tabs by default for `.driver`).
- Comments over several lines and `#if 0` regions keep their position relative to the line that opens them, so
  formatting twice never moves them again.
- Formatting is skipped while the definition has syntax errors.
- clang-format splits nested `?:` chains over several lines; a `.clang-format` in the project can change that.

## Commands

| Command                                                     | Description                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `INDIGO Driver: Generate C Sources`                         | Save the file and run `indigo_generator` on it                     |
| `INDIGO Driver: Open Generated C Source`                    | Open `indigo_<type>_<name>.c` (or `.cpp`) next to the definition   |
| `INDIGO Driver: Use as C/C++ Configuration Provider`        | Make `includePaths` reach the C/C++ extension (workspace settings) |
| `INDIGO Driver: Stop Using as C/C++ Configuration Provider` | Remove that workspace setting again                                |

The generator writes `indigo_<type>_<name>.c|.cpp`, `.h` and `_main.c` in the folder of the `.driver` file.

## Settings

| Setting                          | Default | Description                                                                                                         |
| -------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `indigoDriver.generatorPath`     | `""`    | Absolute path to `indigo_generator`, user settings only. When empty it is looked up in `PATH`                       |
| `indigoDriver.generateOnSave`    | `false` | Run the generator every time a `.driver` file is saved                                                              |
| `indigoDriver.cLanguageFeatures` | `false` | Completion, hover, definition and signature help in code blocks, through the C/C++ extension                        |
| `indigoDriver.includePaths`      | `[]`    | Extra include directories for the C code blocks (`~` and `${workspaceFolder}` are expanded); see the commands above |
| `indigoDriver.lint.enable`       | `true`  | Report syntax, structural and semantic problems while typing                                                        |

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

The names of INDIGO enumerators and types used for coloring come from the INDIGO headers. To refresh them:

```sh
node scripts/update-indigo-names.mjs /path/to/indigo/indigo_libs/indigo
npm run format
```

The parser mirrors the lexer of `indigo_generator`. To check it against real definitions, point `INDIGO_REPO` to a
checkout of the INDIGO repository: every `.driver` file in it must parse without problems.

```sh
INDIGO_REPO=/path/to/indigo npm test
```

## License

MIT, see the `LICENSE` file. The `NOTICE` file explains the relationship with INDIGO and reports its license for reference.
