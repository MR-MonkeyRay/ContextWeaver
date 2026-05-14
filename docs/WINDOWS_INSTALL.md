# Windows Install Notes

ContextWeaver depends on native Node packages for local storage and parsing. Most Windows users should install it normally:

```powershell
npm install -g @monkeyray/contextweaver
```

or:

```powershell
pnpm add -g @monkeyray/contextweaver
```

When prebuilt binaries are available for your Node version and CPU architecture, the install should not need a local C++ build.

## If Native Build Tools Are Needed

If npm or pnpm falls back to building native packages, install:

- Visual Studio Build Tools 2022
- The "Desktop development with C++" workload
- Python available on `PATH` for `node-gyp`

Then retry the normal global install command. This fallback may be used by packages such as `better-sqlite3`, `@keqingmoe/tree-sitter`, or tree-sitter grammar packages when a matching prebuild is unavailable.

## Advanced No-Build Install

Only use this path when you cannot install build tools and understand the tradeoff. You can install with lifecycle scripts disabled, but native packages may be missing or unusable:

```powershell
npm install -g @monkeyray/contextweaver --ignore-scripts
```

or:

```powershell
pnpm add -g @monkeyray/contextweaver --ignore-scripts
```

After that, you must manually provide working native artifacts for the installed package versions. The affected packages can include `better-sqlite3`, `@keqingmoe/tree-sitter`, and tree-sitter grammar packages under the global package installation. Do not assume an upstream `tree-sitter` runtime package path; this project uses `@keqingmoe/tree-sitter`.

## Kotlin and Dart Grammars

Kotlin and Dart AST parsing is conditional. If `tree-sitter-kotlin` or `tree-sitter-dart` cannot load for the current Node ABI and install environment, ContextWeaver falls back to line-based chunks while import resolution remains available.
