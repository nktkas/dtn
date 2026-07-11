/**
 * Builds the generated `package.json` from the {@linkcode Analysis}.
 *
 * @module
 */

import { relative, resolve } from "@std/path";
import sortPackageJson from "sort-package-json";
import type { Analysis } from "./analyze.ts";
import { toPosix, tsToJs } from "./spec.ts";

interface ExportsEntry {
  types?: string;
  default?: string;
}

/**
 * Builds the full `package.json` object.
 *
 * Author fields are overlaid with the computed `name`, `version`, `type`, `exports`, root `main`/`types`, and
 * `dependencies`; keys are then sorted into the conventional `package.json` field order.
 *
 * @example
 * ```ts ignore
 * // For a project `@scope/lib@1.0.0` with one entry `.` -> ./src/mod.ts and an npm dependency `chalk`:
 * const pkg = planPackageJson(analysis);
 * // -> {
 * //   name: "@scope/lib",
 * //   version: "1.0.0",
 * //   type: "module",
 * //   exports: { ".": { types: "./esm/mod.d.ts", default: "./esm/mod.js" } },
 * //   main: "./esm/mod.js",
 * //   types: "./esm/mod.d.ts",
 * //   dependencies: { chalk: "^5" },
 * // }
 * ```
 */
export function planPackageJson(analysis: Analysis): Record<string, unknown> {
  const { plan, srcRoot, npmDeps } = analysis;
  const codeRel = toPosix(relative(plan.outDir, plan.codeDir));

  const exportsMap: Record<string, ExportsEntry> = {};
  for (const [subpath, source] of Object.entries(plan.exports)) {
    const rel = toPosix(relative(srcRoot, resolve(plan.repoRoot, source)));
    if (rel.endsWith(".d.ts")) {
      exportsMap[subpath] = { types: `./${codeRel}/${rel}` };
    } else {
      exportsMap[subpath] = {
        types: `./${codeRel}/${rel.replace(/\.ts$/, ".d.ts")}`,
        default: `./${codeRel}/${tsToJs(rel)}`,
      };
    }
  }

  // `exports` is invisible to React Native's Metro before 0.79 and to TypeScript's node10 resolution; both read the
  // root `main`/`types` instead.
  const root = exportsMap["."];
  const rootFields = {
    ...(root?.default !== undefined ? { main: root.default } : {}),
    ...(root?.types !== undefined ? { types: root.types } : {}),
  };

  return sortPackageJson({
    ...plan.packageJson,
    name: plan.name,
    version: plan.version,
    type: "module",
    ...rootFields,
    exports: exportsMap,
    ...(Object.keys(npmDeps).length > 0 ? { dependencies: npmDeps } : {}),
  });
}
