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
//     ├── _deps/jsr.io/@std/encoding/1.0.0/hex.js  (+ .js.map, .d.ts)
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
    exports: string | Record<string, string>;
    imports?: Record<string, string>;
  };
  /**
   * Replaces an import-map alias — which must resolve to a `jsr:`/`npm:` specifier — with an npm package instead of
   * vendoring it, given as `"name"` or `"name@version"`; an omitted version is taken from that specifier.
   */
  npmReplacements?: Record<string, string>;
  /**
   * Extra `package.json` fields to merge in. The engine always sets `name`, `version`, `type`, `exports`, the root
   * `main`/`types`, and `dependencies` itself, overwriting any value you pass for those keys.
   */
  packageJson?: PackageJson;
  /** Files copied verbatim into the package root. */
  copyFiles?: string[];
  /** Source-map mode: `"separate"` (a `.js.map` beside each `.js`), `"inline"` (embedded), or `"none"`. @default "separate" */
  sourceMap?: "separate" | "inline" | "none";
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
  if (e instanceof BuildError && e.code === "REPLACEMENT_ALIAS_UNKNOWN") { /* ... */ }
}
```

| `code`                            | Raised when                                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `INVALID_EXPORTS`                 | `deno.exports` is empty, an entry is not a `.ts`/`.d.ts` source, or a wildcard export has no single matching `*`. |
| `REPLACEMENT_ALIAS_UNKNOWN`       | An `npmReplacements` alias is absent from `deno.imports`.                                                         |
| `REPLACEMENT_TARGET_INVALID`      | A replaced alias maps to neither a `jsr:` nor an `npm:` specifier.                                                |
| `REPLACEMENT_DIRECT_IMPORT`       | Local code imports a replaced package via its raw specifier instead of its import-map alias.                      |
| `UNSUPPORTED_LOCAL_SOURCE`        | A local source is not a `.ts`/`.js`/`.mjs`/`.cjs`/`.json`/`.d.ts`/`.wasm` file.                                   |
| `UNSUPPORTED_VENDORED_DEPENDENCY` | A vendored dependency cannot be inlined (an unsupported media type, or a hostless URL like `data:`).              |
| `UNRESOLVED_SPECIFIER`            | A specifier resolves to neither a vendored file nor an npm package.                                               |
| `MODULE_LOAD_FAILED`              | A module's source cannot be read from the Deno cache.                                                             |
| `TRANSPILE_FAILED`                | The `deno transpile` subprocess fails (e.g. a type error), or does not emit an expected artifact.                 |
| `REWRITE_PARSE_FAILED`            | An emitted or vendored module cannot be parsed for specifier rewriting.                                           |

## Limitations

These valid-Deno cases are unsupported — not detected, with undefined output:

- **Import-map `scopes` are not supported.**
- **Type-sidecar directives (`@ts-types`/`@deno-types`/`@ts-self-types`) are not honored.**
- **Two remote URLs differing only by a query string collide on one vendored path.**
- **Two version requirements for one npm package collide on a single `dependencies` entry; which wins is undefined.**

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
