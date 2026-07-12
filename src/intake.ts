/**
 * Validates the build config and normalizes it into a {@linkcode Plan}.
 *
 * @module
 */

import { join, resolve } from "@std/path";
import type { PackageJson } from "type-fest";
import { BuildError } from "./errors.ts";
import { parseRegistry, parseReplacement } from "./spec.ts";

/**
 * The `deno.json` configuration for the package.
 *
 * @see https://docs.deno.com/runtime/fundamentals/configuration/
 */
export interface DenoConfig {
  /** npm package name. */
  name: string;
  /** npm package version. */
  version: string;
  /** Runtime TypeScript entry point or explicit subpath map. */
  exports: string | Record<string, string>;
  /** Aliases targeting `jsr:` or `npm:` packages. */
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
  /** Package metadata and registry aliases from `deno.json`. */
  denoJson: DenoConfig;
  /**
   * Import-map aliases whose dependency is replaced by an npm package instead of being vendored.
   *
   * The value is the npm package name, optionally with a version range (`"valibot"` or `"valibot@^1"`);
   * an omitted version comes from the alias's import specifier. Every alias must exist in `deno.imports`.
   */
  npmReplacements?: Record<string, string>;
  /**
   * Fields merged into the generated `package.json`; these engine-computed fields take precedence:
   * `name`, `version`, `type`, `exports`, root `main`/`types`, and `dependencies`.
   */
  packageJson?: PackageJson;
  /** Files copied verbatim into the package root, such as `README.md` and `LICENSE`. */
  copyFiles?: string[];
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
  depsDir: string;
}

/**
 * Validates {@linkcode config}, resolves its paths against {@linkcode repoRoot}, and yields a {@linkcode Plan}.
 *
 * @throws {BuildError} `INVALID_CONFIG` when exports, imports, or npm replacements violate the supported contract.
 *
 * @example
 * ```ts
 * const plan = intake({
 *   outDir: "dist",
 *   denoJson: {
 *     name: "@scope/lib",
 *     version: "1.0.0",
 *     exports: "./src/mod.ts", // a string exports normalizes to a "." entry
 *     imports: {
 *       "@valibot/valibot": "jsr:@valibot/valibot@1",
 *     }, // jsr alias, replaced below by an npm package
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

  for (const [alias, target] of Object.entries(imports)) {
    if (parseRegistry(target) === null) {
      throw new BuildError("INVALID_CONFIG", "import-map aliases must target an npm or JSR package", {
        subject: alias,
      });
    }
    if (alias.endsWith("/") !== target.endsWith("/")) {
      throw new BuildError("INVALID_CONFIG", "import-map prefix aliases and targets must both end with '/'", {
        subject: alias,
      });
    }
  }

  for (const [alias, replacement] of Object.entries(npmReplacements)) {
    if (!Object.hasOwn(imports, alias)) {
      throw new BuildError("INVALID_CONFIG", "npmReplacements alias is missing from the deno.json import map", {
        subject: alias,
      });
    }
    if (parseReplacement(replacement) === null) {
      throw new BuildError("INVALID_CONFIG", "npmReplacements value is not an npm package name", { subject: alias });
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
    depsDir: config.depsDir ?? "_deps",
  };
}

/**
 * Normalizes `deno.exports` (a string or a subpath → source map) into a subpath → source map.
 *
 * @throws {BuildError} `INVALID_CONFIG` when exports are empty or an entry is not one explicit runtime `.ts` source.
 */
function normalizeExports(exports: string | Record<string, string>): Record<string, string> {
  const map = typeof exports === "string" ? { ".": exports } : exports;
  const entries = Object.entries(map);
  if (entries.length === 0) {
    throw new BuildError("INVALID_CONFIG", "deno.json has no exports to build from");
  }
  for (const [subpath, source] of entries) {
    if (source.length === 0) {
      throw new BuildError("INVALID_CONFIG", "export entry is not a source path", { subject: subpath });
    }
    if (subpath !== "." && !subpath.startsWith("./")) {
      throw new BuildError("INVALID_CONFIG", "export key must be '.' or start with './'", { subject: subpath });
    }
    if (!source.endsWith(".ts") || source.endsWith(".d.ts") || source.includes("*") || subpath.includes("*")) {
      throw new BuildError("INVALID_CONFIG", "export entry must be one explicit runtime .ts source", {
        subject: `${subpath} → ${source}`,
      });
    }
  }
  return { ...map };
}
