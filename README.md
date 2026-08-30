# @nktkas/dtn

[![JSR](https://jsr.io/badges/@nktkas/dtn)](https://jsr.io/@nktkas/dtn)

`dtn` (Deno To Node) — Builds a [Deno](https://deno.com/) library into a [Node](https://nodejs.org/) package ready to
publish to npm, using [`deno info`](https://docs.deno.com/runtime/reference/cli/info/) for resolution and
[`typescript`](https://www.npmjs.com/package/typescript) for emit.

## Install

```
deno add jsr:@nktkas/dtn
```

## Usage

```ts ignore
// deno.json
// {
//   "name": "@scope/lib",
//   "version": "1.0.0",
//   "exports": "./src/mod.ts",
//   "imports": {
//     "@valibot/valibot": "jsr:@valibot/valibot@^1",
//     "@std/encoding/hex": "jsr:@std/encoding@^1/hex"
//   }
// }

import { build } from "@nktkas/dtn";
import denoJson from "./deno.json" with { type: "json" };

await build({
  outDir: "dist",
  denoJson,
  npmReplacements: { "@valibot/valibot": "valibot" },
});

// dist/
// ├── package.json  (generated fields, "valibot" among the dependencies)
// ├── tsconfig.json
// └── esm/
//     ├── mod.js  (+ mod.js.map, mod.d.ts)
//     ├── _deps/jsr.io/@std/encoding/1.0.0/hex.js  (+ hex.js.map, hex.d.ts)
//     └── ...  (other local files related to mod.js)
```

## Options

````ts
interface BuildOptions {
  /**
   * Output directory, resolved against the current working directory.
   *
   * WARNING: the directory is removed, with everything inside it, before the build writes anything.
   */
  outDir: string;
  /**
   * Project root that entry points resolve against.
   *
   * @default `Deno.cwd()`
   */
  root?: string;
  /**
   * The project config to build from.
   *
   * @see https://docs.deno.com/runtime/fundamentals/configuration/
   */
  denoJson: {
    name: string;
    version: string;
    exports: string | Record<string, string>;
    imports?: Record<string, string>;
    scopes?: Record<string, Record<string, string>>;
    importMap?: string;
    nodeModulesDir?: "auto" | "manual" | "none" | boolean;
    compilerOptions?: Record<string, unknown>;
  };
  /**
   * Import-map aliases installed from npm instead of being copied into the package.
   *
   * Every other JSR or HTTPS dependency is copied into {@linkcode BuildOptions.depsDir}.
   *
   * @example
   * ```ts
   * // deno.json holds "@hono/hono": "jsr:@hono/hono@^4.6.3"
   * { "@hono/hono": "hono" }   // => import "@hono/hono/jsx"  ->  import "hono/jsx"
   * ```
   */
  npmReplacements?: Record<string, string>;
  /** Fields merged into the generated `package.json`, over the fields the build writes itself. */
  packageJson?: Record<string, unknown>;
  /**
   * Directory under each module-kind tree holding the dependencies copied into the package.
   *
   * @default `"_deps"`
   */
  depsDir?: string;
  /**
   * Whether to write a source map beside each module, with the TypeScript source inside it.
   *
   * @default `true`
   */
  sourceMap?: boolean;
  /**
   * The module kinds the package holds.
   * - `"esm"`: ESM alone, in `esm/`.
   * - `"cjs"`: CommonJS alone, in `cjs/`.
   * - `"both"`: ESM in `esm/` and CommonJS in `cjs/`.
   *
   * @default `"esm"`
   */
  modules?: "esm" | "cjs" | "both";
}
````

## Errors

`build()` throws a `BuildError` carrying a machine-readable `code`:

```ts ignore
import { build, BuildError } from "@nktkas/dtn";
import denoJson from "./deno.json" with { type: "json" };

try {
  await build({ outDir: "dist", denoJson });
} catch (e) {
  if (e instanceof BuildError && e.code === "INVALID_CONFIG") console.error(e.message);
}
```

| `code`                | Raised when                                                       |
| --------------------- | ----------------------------------------------------------------- |
| `INVALID_CONFIG`      | The project's imports, versions and installed packages disagree.  |
| `DEPENDENCY_FAILED`   | A `deno` command fails, or reports a module it could not load.    |
| `EMIT_FAILED`         | `tsc` refuses to produce the package's modules and declarations.  |
| `UNSHIPPABLE_PACKAGE` | The modules resolve, but the package they would make cannot load. |
| `IO_FAILED`           | The file system or the runtime refuses the build something.       |
| `UNKNOWN_ERROR`       | The build breaks on anything else.                                |

## Limitations

- **The input is a valid Deno project with APIs that are supported in Node; anything else fails loudly, or is quietly
  built into an invalid Node package ([Deno APIs](https://docs.deno.com/api/deno/) are not shimmed and
  [Web APIs](https://developer.mozilla.org/docs/Web/API) are not polyfilled).**
- **A source is renamed to what Node reads, so `util.ts` and `util.js` both claim `esm/util.js` and cannot ship
  together.**

## Alternatives

### [`deno pack`](https://docs.deno.com/runtime/reference/cli/pack/)

Starting with [Deno 2.8](https://deno.com/blog/v2.8#deno-pack), Deno builds a project into a publication-ready npm
package itself.

But it has some serious issues, at least for me:

- To convert a JSR import to its npm equivalent, you must first manually edit `deno.json#imports`, and the alias itself
  has to be the npm package's name: `deno pack` leaves every alias in the code as written.
- JSR dependencies are not copied into the package: they ship as `@jsr/*` npm dependencies, which need an
  [`.npmrc`](https://docs.deno.com/runtime/reference/cli/pack/#specifier-rewriting).
- [Slow types](https://docs.deno.com/runtime/reference/cli/pack/#allow-slow-types) are not supported and are converted
  to `any`.

### [`dnt`](https://github.com/denoland/dnt)

Deno's own tool for the same job, older than `deno pack` and still maintained, if rarely updated.

Complete as the library is, it has issues of its own:

- WebAssembly modules are unsupported ([#439](https://github.com/denoland/dnt/issues/439)).
- A JSON module ships as JavaScript, so the `.json` file itself is not in the package.

## License

**@nktkas/dtn** is licensed under the [MIT License](LICENSE).

Copyright © 2026-present [nktkas](https://github.com/nktkas).
