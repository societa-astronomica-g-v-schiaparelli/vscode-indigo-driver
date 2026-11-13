# Changelog

## 0.2.0

- C language features inside code blocks, through the C/C++ extension on a generated copy of the driver: completion,
  hover, go to definition and signature help (`indigoDriver.cLanguageFeatures`, `indigoDriver.includePaths`). Extra include paths reach the C/C++ extension
  through an explicit command that writes its provider setting to the workspace, never on its own.
- Richer coloring of the C code blocks without a language server: INDIGO enumerators, macros, types, functions and
  the `device` parameter.
- Generated working files in the extension storage folder that were not used for 30 days are removed at startup.
- Format Document and Format Selection for the C code blocks, with the C/C++ formatter and the `.clang-format` of the
  project.

## 0.1.0

- Syntax highlighting with embedded C, outline, folding, diagnostics, completion, hover and snippets for INDIGO 3
  `.driver` files.
- `indigo_generator` integration: generate on demand or on save, generator errors shown as diagnostics.
