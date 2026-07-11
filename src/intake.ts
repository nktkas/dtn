/**
 * Validates the build config and normalizes it into a {@linkcode Plan}.
 *
 * @module
 */

import { join, resolve } from "@std/path";
import type { PackageJson } from "type-fest";
import { BuildError } from "./errors.ts";
import { parseRegistry } from "./spec.ts";

/** Source-map modes accepted by {@linkcode BuildConfig.sourceMap}. */
export const SOURCE_MAP_MODES = ["inline", "separate", "none"] as const;

/**
 * The `deno.json` configuration for the package.
 *
 * @see https://docs.deno.com/runtime/fundamentals/configuration/
 */
export interface DenoConfig {
  name: string;
  version: string;
  exports: string | Record<string, string>;
  imports?: Record<string, string>;
}

/** Everything the engine needs that is not derivable from `deno.json`, supplied as build parameters. */
export interface BuildConfig {
  /** Output directory, relative to the project root. */
  outDir: string;
  /**
   * Project root against which relative paths resolve.
   *
   * @default Deno.cwd()
   */
  root?: string;
  denoJson: DenoConfig;
  /**
   * Import-map aliases whose dependency is replaced by an npm package instead of being vendored.
   *
   * The value is the npm package name, optionally with a version range (`"valibot"` or `"valibot@^1"`); when the
   * version is omitted it is taken from the alias's import specifier. Every alias must exist in `deno.imports`.
   */
  npmReplacements?: Record<string, string>;
  /**
   * Fields merged into the generated `package.json`. The engine computes `name`, `version`, `type`, `exports`, the
   * root `main`/`types`, and `dependencies`; these take precedence over the same keys provided here.
   */
  packageJson?: PackageJson;
  /** Files copied verbatim into the package root (e.g. `README.md`, `LICENSE`). */
  copyFiles?: string[];
  /**
   * Source-map mode:
   * - `"none"`: no source map
   * - `"inline"`: embed the source map as a `data:` comment in each file
   * - `"separate"`: write a sibling `.js.map` (or `.mjs.map` / `.cjs.map`)
   *
   * @default "separate"
   */
  sourceMap?: (typeof SOURCE_MAP_MODES)[number];
  /**
   * Directory under the package code root that holds inlined (vendored) dependencies.
   *
   * @default "_deps"
   */
  depsDir?: string;
}

/** The validated, path-resolved build input, produced only by {@linkcode intake}. */
export interface Plan {
  repoRoot: string;
  outDir: string;
  /** Where all package code is written (`<outDir>/esm`). */
  codeDir: string;
  /** Scratch tree for vendored sources and the declaration pass (`<outDir>/.dts-tmp`). */
  tmpDir: string;
  name: string;
  version: string;
  /** Entry points normalized to a subpath → repo-relative source path map. */
  exports: Record<string, string>;
  imports: Record<string, string>;
  npmReplacements: Record<string, string>;
  packageJson: PackageJson;
  copyFiles: string[];
  sourceMap: (typeof SOURCE_MAP_MODES)[number];
  depsDir: string;
}

/**
 * Validates {@linkcode config} and resolves its paths against {@linkcode repoRoot}, yielding a {@linkcode Plan}.
 *
 * @throws {BuildError} `INVALID_EXPORTS` when `deno.exports` is empty, an entry is not a `.ts`/`.d.ts` source, or a
 *                       wildcard export has no single matching `*` in subpath and source.
 * @throws {BuildError} `REPLACEMENT_ALIAS_UNKNOWN` when an `npmReplacements` alias is absent from `deno.imports`.
 * @throws {BuildError} `REPLACEMENT_TARGET_INVALID` when a replaced alias maps to neither a jsr nor an npm specifier.
 *
 * @example
 * ```ts
 * const plan = intake({
 *   outDir: "dist",
 *   denoJson: {
 *     name: "@scope/lib",
 *     version: "1.0.0",
 *     exports: "./src/mod.ts", // a string exports normalizes to a "." entry
 *     imports: { "@valibot/valibot": "jsr:@valibot/valibot@1" }, // jsr alias, replaced below by an npm package
 *   },
 *   npmReplacements: { "@valibot/valibot": "valibot" },
 * }, "/repo");
 *
 * // `plan` is the validated, path-resolved input consumed by every later stage:
 * // plan.outDir          -> "/repo/dist"             (resolved against repoRoot)
 * // plan.codeDir         -> "/repo/dist/esm"         (where all package code is written)
 * // plan.exports         -> { ".": "./src/mod.ts" }  (the string exports normalized to a "." entry)
 * // plan.npmReplacements -> { "@valibot/valibot": "valibot" }
 * ```
 */
export function intake(config: BuildConfig, repoRoot: string): Plan {
  const exports = normalizeExports(config.denoJson.exports);
  const imports = config.denoJson.imports ?? {};
  const npmReplacements = config.npmReplacements ?? {};

  for (const alias of Object.keys(npmReplacements)) {
    const target = imports[alias];
    if (target === undefined) {
      throw new BuildError(
        "REPLACEMENT_ALIAS_UNKNOWN",
        `npmReplacements alias is missing from the deno.json import map`,
        alias,
      );
    }
    if (parseRegistry(target) === null) {
      throw new BuildError(
        "REPLACEMENT_TARGET_INVALID",
        `npmReplacements alias maps to neither a jsr nor an npm specifier`,
        alias,
      );
    }
  }

  const outDir = resolve(repoRoot, config.outDir);
  return {
    repoRoot,
    outDir,
    codeDir: join(outDir, "esm"),
    tmpDir: join(outDir, ".dts-tmp"),
    name: config.denoJson.name,
    version: config.denoJson.version,
    exports,
    imports,
    npmReplacements,
    packageJson: config.packageJson ?? {},
    copyFiles: config.copyFiles ?? [],
    sourceMap: config.sourceMap ?? "separate",
    depsDir: config.depsDir ?? "_deps",
  };
}

/**
 * Normalizes `deno.exports` (a string or a subpath → source map) into a subpath → source map.
 *
 * @throws {BuildError} `INVALID_EXPORTS` when there are no exports, an entry is not a `.ts`/`.d.ts` source, or a
 *                       wildcard export has no single matching `*` in subpath and source.
 */
function normalizeExports(exports: string | Record<string, string>): Record<string, string> {
  const map = typeof exports === "string" ? { ".": exports } : exports;
  const entries = Object.entries(map);
  if (entries.length === 0) {
    throw new BuildError("INVALID_EXPORTS", "deno.json has no exports to build from");
  }
  for (const [subpath, source] of entries) {
    if (source.length === 0) {
      throw new BuildError("INVALID_EXPORTS", `export entry is not a source path`, subpath);
    }
    // Only `.ts` and `.d.ts` entry points yield a typed, behavior-preserving export.
    if (!source.endsWith(".ts")) {
      throw new BuildError("INVALID_EXPORTS", `export entry must be a .ts or .d.ts source`, `${subpath} → ${source}`);
    }
    const srcStars = (source.match(/\*/g) ?? []).length;
    if (srcStars !== (subpath.match(/\*/g) ?? []).length || srcStars > 1) {
      throw new BuildError(
        "INVALID_EXPORTS",
        `a wildcard export needs exactly one matching "*" in subpath and source`,
        `${subpath} → ${source}`,
      );
    }
  }
  return { ...map };
}
