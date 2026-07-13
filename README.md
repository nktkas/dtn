# @nktkas/dtn

[![JSR](https://jsr.io/badges/@nktkas/dtn)](https://jsr.io/@nktkas/dtn)
[![coveralls](https://img.shields.io/coverallsCoverage/github/nktkas/dtn)](https://coveralls.io/github/nktkas/dtn)

Deno to Node — build a Deno project into a Node-compatible project (no bundling).

## Install (Deno 2.8+)

```
deno add jsr:@nktkas/dtn
```

## Usage

```ts ignore
import { build } from "@nktkas/dtn";
import denoJson from "./deno.json" with { type: "json" };
// -> {
//   "name": "@scope/lib",
//   "version": "1.0.0",
//   "exports": "./src/mod.ts",
//   "imports": {
//     "@valibot/valibot": "jsr:@valibot/valibot@^1",
//     "@std/encoding/hex": "jsr:@std/encoding@^1/hex"
//   }
// }

await build({
  outDir: "dist",
  denoJson,
  npmReplacements: { "@valibot/valibot": "valibot" },
  copyFiles: ["README.md", "LICENSE"],
});
// dist/
// ├── README.md
// ├── LICENSE
// ├── package.json
// └── esm/
//     ├── mod.js  (+ mod.js.map, mod.d.ts)
//     ├── _deps/.../mod.js  (+ mod.js.map, mod.d.ts)
//     └── ...     other local files related to mod.js
```

## Config

```ts
interface BuildConfig {
  /** Output directory, relative to the project root. */
  outDir: string;
  /** Project root against which relative paths resolve. @default Deno.cwd() */
  root?: string;
  /** Package facts from `deno.json`. */
  denoJson: {
    name: string;
    version: string;
    /** Explicit runtime `.ts` entry or subpath map; wildcards and `.d.ts`-only entries are unsupported. */
    exports: string | Record<string, string>;
    /** Aliases targeting `jsr:` or `npm:` packages. */
    imports?: Record<string, string>;
  };
  /**
   * Replaces an import-map alias — which must resolve to a `jsr:`/`npm:` specifier — with an npm package instead of
   * vendoring it, given as `"name"` or `"name@version"`; an omitted version is taken from that specifier.
   */
  npmReplacements?: Record<string, string>;
  /** Fields merged into the generated `package.json`; dtn-generated values take precedence. */
  packageJson?: PackageJson;
  /** Files copied verbatim into the package root. */
  copyFiles?: string[];
  /** Directory under the package code root that holds inlined (vendored) dependencies. @default "_deps" */
  depsDir?: string;
}
```

## Errors

`build()` throws a `BuildError` with a machine-readable `code` and, when known, the offending `subject`:

```ts ignore
import { build, BuildError } from "@nktkas/dtn";

try {
  await build(config);
} catch (e) {
  if (e instanceof BuildError && e.code === "INVALID_CONFIG") { /* ... */ }
}
```

| `code`               | Raised when                                                                    |
| -------------------- | ------------------------------------------------------------------------------ |
| `INVALID_CONFIG`     | Exports, registry aliases, or npm replacements violate the supported contract. |
| `UNSUPPORTED_MODULE` | A module has an unsupported origin or media type.                              |
| `DEPENDENCY_FAILED`  | A dependency cannot be loaded or resolved to package output.                   |
| `EMIT_FAILED`        | Transpilation, expected artifacts, rewriting, or source maps fail.             |
| `BUILD_FAILED`       | Another platform or library operation fails.                                   |

The original platform or library error is available through `error.cause` when one exists.

## Limitations

The intentionally supported scope is narrower than Deno's module system:

- **Import-map `scopes` are unsupported; aliases may target only `jsr:` or `npm:` packages.**
- **Remote modules are accepted only inside a JSR graph.**
- **Local and vendored JSR modules are limited to TypeScript, JavaScript, MJS, and declaration files.**
- **Only static ESM and TypeScript `import()` type specifiers are rewritten; runtime `import()`,
  `import.meta.resolve()`, CommonJS, TypeScript `import = require`, module declarations/augmentations, triple-slash
  references, and JavaScript JSDoc are not.**
- **Type-sidecar directives (`@ts-types`/`@deno-types`/`@ts-self-types`) are not honored.**
- **Deno runtime APIs are not shimmed for Node.**
- **Dependency graph resolution ignores `deno.lock`.**
- **Only transpiled TypeScript gets source maps; copied JavaScript/MJS maps and mapping directives are omitted.**
- **Validation and graph analysis preserve existing output; emission failures may leave partial output.**
- **Conflicting versions of one npm package share one dependency entry; the winner is undefined.**

## Alternatives

### [`deno pack`](https://docs.deno.com/runtime/reference/cli/pack/)

Starting with [Deno 2.8](https://deno.com/blog/v2.8#deno-pack), a similar tool was added to build a Deno project into a
publication-ready npm package.

But it has some serious (for me) issues:

- To convert a JSR import to its npm equivalent, you must first manually edit `deno.json#imports`.
- After installing, the npm user needs to
  [configure the `.npmrc`](https://docs.deno.com/runtime/reference/cli/pack/#specifier-rewriting) file in their project
  to work with jsr dependencies.
- [Slow types](https://docs.deno.com/runtime/reference/cli/pack/#allow-slow-types) are not supported; they will be
  converted to `any`.

### [`dnt`](https://github.com/denoland/dnt)

A popular tool for converting a Deno project into a Node-compatible project.

But it also has a few issues:

- Does not support a mapping from JSR imports to their npm equivalents; requires manual modification of
  `deno.json#imports` beforehand (https://github.com/denoland/dnt/issues/437)
- Most likely, active support has been suspended (based on: the latest git commit date and the number of active issues)

## License

**@nktkas/dtn** is licensed under the [MIT License](LICENSE).

Copyright © 2026-present [nktkas](https://github.com/nktkas).
