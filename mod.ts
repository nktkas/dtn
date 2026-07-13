/**
 * Turns a Deno project into an ESM-only npm package — file for file, not a bundle.
 *
 * Rewrites specifiers for Node, replaces or vendors dependencies,
 * and synthesizes `package.json` while preserving runtime behavior, public types, and generated source maps.
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
 * //     ├── _deps/.../mod.js  (+ mod.js.map, mod.d.ts)
 * //     └── ...     other local files related to mod.js
 * ```
 *
 * @module
 */

import { resolve } from "@std/path";
import { analyze } from "./src/analyze.ts";
import { BuildError } from "./src/errors.ts";
import * as fs from "./src/fs.ts";
import { type BuildConfig, intake } from "./src/intake.ts";
import { loadGraph } from "./src/graph.ts";
import { packageStage, rewriteStage, transpileStage, vendorStage } from "./src/stages.ts";

export { BuildError };
export type { BuildErrorCode } from "./src/errors.ts";
export type { BuildConfig, DenoConfig } from "./src/intake.ts";

/**
 * Builds the package described by {@linkcode config} into `config.outDir`.
 *
 * Limitations:
 * - Only transpiled TypeScript gets source maps; copied JavaScript/MJS maps and mapping directives are omitted.
 * - Dependency graph resolution ignores `deno.lock`.
 * - Deno runtime APIs are not shimmed for Node.
 * - The `deno.json` import map's `scopes` are not supported.
 * - Type-sidecar directives (`@ts-types`/`@deno-types`/`@ts-self-types`) are not honored.
 * - Generated absolute `file:` imports fail; use explicit type annotations.
 * - Only static ESM and TypeScript `import()` type specifiers are rewritten; runtime `import()`, `import.meta.resolve()`,
 *   CommonJS, TypeScript `import = require`, module declarations/augmentations, triple-slash references, and JavaScript JSDoc are not.
 * - Conflicting versions of one npm package share one dependency entry; the winner is undefined.
 * - Validation and graph analysis preserve existing output; emission failures may leave partial output.
 *
 * @param config Package metadata, output policy, registry replacements, and project root.
 * @return A promise fulfilled after all package artifacts have been written.
 *
 * @throws {BuildError} `INVALID_CONFIG` when the supplied configuration violates the supported contract.
 * @throws {BuildError} `UNSUPPORTED_MODULE` when a reachable module has an unsupported origin or media type.
 * @throws {BuildError} `DEPENDENCY_FAILED` when a dependency cannot be loaded or resolved to package output.
 * @throws {BuildError} `EMIT_FAILED` when transpilation or output rewriting fails.
 * @throws {BuildError} `BUILD_FAILED` when another platform or library operation fails.
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
 * //     ├── _deps/.../mod.js  (+ mod.js.map, mod.d.ts)
 * //     └── ...     other local files related to mod.js
 * ```
 */
export async function build(config: BuildConfig): Promise<void> {
  try {
    const plan = intake(config, resolve(config.root ?? "."));
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
  } catch (cause) {
    if (cause instanceof BuildError) throw cause;
    throw new BuildError("BUILD_FAILED", "build failed", { cause });
  }
}
