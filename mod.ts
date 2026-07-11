/**
 * Turns a Deno project into an ESM-only npm package — file for file, not a bundle.
 *
 * Rewrites specifiers for Node resolution, replaces or vendors dependencies, and synthesizes `package.json` —
 * preserving runtime behavior, public types, and source maps.
 *
 * @example
 * ```ts ignore
 * import { build } from "@nktkas/dtn";
 * import denoJson from "./deno.json" with { type: "json" };
 * // -> {
 * //   "name": "@scope/lib",
 * //   "version": "1.0.0",
 * //   "exports": "./src/mod.ts",
 * //   "imports": {
 * //     "@valibot/valibot": "jsr:@valibot/valibot@^1",
 * //     "@std/encoding/hex": "jsr:@std/encoding@^1/hex"
 * //   }
 * // }
 *
 * await build({
 *   outDir: "dist",
 *   denoJson,
 *   npmReplacements: { "@valibot/valibot": "valibot" },
 *   copyFiles: ["README.md", "LICENSE"],
 * });
 * // dist/
 * // ├── README.md
 * // ├── LICENSE
 * // ├── package.json
 * // └── esm/
 * //     ├── mod.js  (+ mod.js.map, mod.d.ts)
 * //     ├── _deps/jsr.io/@std/encoding/1.0.0/hex.js  (+ .js.map, .d.ts)
 * //     └── ...     other local files related to mod.js
 * ```
 *
 * @module
 */

import { analyze } from "./src/analyze.ts";
import * as fs from "./src/fs.ts";
import { type BuildConfig, intake } from "./src/intake.ts";
import { expandExports, loadGraph } from "./src/graph.ts";
import { packageStage, rewriteStage, transpileStage, vendorStage } from "./src/stages.ts";

export { BuildError } from "./src/errors.ts";
export type { BuildErrorCode } from "./src/errors.ts";
export type { BuildConfig, DenoConfig } from "./src/intake.ts";

/**
 * Builds the package described by {@linkcode config} into `config.outDir`.
 *
 * The contract below is trusted unchecked; breaking it yields undefined output, not a `BuildError`:
 * - The `deno.json` import map's `scopes` are not supported.
 * - Type-sidecar directives (`@ts-types`/`@deno-types`/`@ts-self-types`) are not honored.
 * - Two remote URLs that differ only by a query string collide on one vendored path.
 *
 * @throws {BuildError} `INVALID_EXPORTS` when `deno.exports` is empty, an entry is not a `.ts`/`.d.ts` source, or a
 *                       wildcard export has no single matching `*` in subpath and source.
 * @throws {BuildError} `REPLACEMENT_ALIAS_UNKNOWN` when an `npmReplacements` alias is absent from `deno.imports`.
 * @throws {BuildError} `REPLACEMENT_TARGET_INVALID` when a replaced alias maps to neither a jsr nor an npm specifier.
 * @throws {BuildError} `UNSUPPORTED_LOCAL_SOURCE` when a local source is not a
 *                       `.ts`/`.js`/`.mjs`/`.cjs`/`.json`/`.d.ts`/`.wasm` file.
 * @throws {BuildError} `UNSUPPORTED_VENDORED_DEPENDENCY` when a vendored dependency cannot be inlined (an unsupported
 *                       media type, or a hostless URL like `data:`).
 * @throws {BuildError} `REPLACEMENT_DIRECT_IMPORT` when local code imports a replaced package via its raw specifier
 *                       (e.g. `jsr:@valibot/valibot@^1`) instead of its import-map alias.
 * @throws {BuildError} `UNRESOLVED_SPECIFIER` when a specifier resolves to neither a vendored file nor an npm package.
 * @throws {BuildError} `MODULE_LOAD_FAILED` when a module's source cannot be read from the Deno cache.
 * @throws {BuildError} `TRANSPILE_FAILED` when the `deno transpile` subprocess exits non-zero (e.g. a type error).
 * @throws {BuildError} `REWRITE_PARSE_FAILED` when an emitted or vendored module cannot be parsed for specifier
 *                       rewriting.
 *
 * @example
 * ```ts ignore
 * import { build } from "@nktkas/dtn";
 * import denoJson from "./deno.json" with { type: "json" };
 * // -> {
 * //   "name": "@scope/lib",
 * //   "version": "1.0.0",
 * //   "exports": "./src/mod.ts",
 * //   "imports": {
 * //     "@valibot/valibot": "jsr:@valibot/valibot@^1",
 * //     "@std/encoding/hex": "jsr:@std/encoding@^1/hex"
 * //   }
 * // }
 *
 * await build({
 *   outDir: "dist",
 *   denoJson,
 *   npmReplacements: { "@valibot/valibot": "valibot" },
 *   copyFiles: ["README.md", "LICENSE"],
 * });
 * // dist/
 * // ├── README.md
 * // ├── LICENSE
 * // ├── package.json
 * // └── esm/
 * //     ├── mod.js  (+ mod.js.map, mod.d.ts)
 * //     ├── _deps/jsr.io/@std/encoding/1.0.0/hex.js  (+ .js.map, .d.ts)
 * //     └── ...     other local files related to mod.js
 * ```
 */
export async function build(config: BuildConfig): Promise<void> {
  const plan = await expandExports(intake(config, Deno.cwd()));
  const graph = await loadGraph(plan);
  const analysis = analyze(plan, graph);

  await fs.rmrf(plan.outDir);
  try {
    await vendorStage(analysis, graph);
    await transpileStage(analysis);
    await rewriteStage(analysis);
    await packageStage(analysis);
  } finally {
    await fs.rmrf(plan.tmpDir);
  }
}
