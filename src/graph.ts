/**
 * Reads the project's module graph and source files through `@deno/graph` and the Deno cache, flattened into plain
 * {@linkcode RawGraph} data.
 *
 * @module
 */

import { createGraph, type MediaType } from "@deno/graph";
import { createCache } from "@deno/cache-dir";
import { expandGlob } from "@std/fs";
import { join, relative, resolve, toFileUrl } from "@std/path";
import { BuildError } from "./errors.ts";
import { makeResolver, toPosix, wildcardSubpath } from "./spec.ts";
import type { Plan } from "./intake.ts";

/** A graph edge: the specifier as written, and what Deno resolves it to (after redirects). */
export interface RawDependency {
  specifier: string;
  resolved: string | undefined;
}

/** A module's media type: the string values of `@deno/graph`'s `MediaType` enum, without its runtime object. */
export type RawMediaType = `${MediaType}`;

/** A graph module. `mediaType` is absent for npm and failed modules. */
export interface RawModule {
  specifier: string;
  mediaType: RawMediaType | undefined;
  error: string | undefined;
  dependencies: RawDependency[];
}

/** The flattened module graph plus Deno-cache source access. */
export interface RawGraph {
  modules: RawModule[];
  /**
   * Reads a module's source bytes from the Deno cache.
   *
   * @throws {BuildError} `MODULE_LOAD_FAILED` when the entry is not a loadable module (an unreadable, redirected, or
   *   external entry).
   */
  readSource(specifier: string): Promise<Uint8Array>;
}

/**
 * Expands any `*` wildcard in `plan.exports` against the filesystem, replacing each wildcard entry with one concrete
 * `subpath → source` entry per matched file. Concrete entries pass through unchanged.
 *
 * @example
 * ```ts ignore
 * // plan.exports is { "./*": "./src/*.ts" }, with src/a.ts and src/b.ts on disk:
 * const expanded = await expandExports(plan);
 * // expanded.exports -> { "./a": "./src/a.ts", "./b": "./src/b.ts" }
 * ```
 */
export async function expandExports(plan: Plan): Promise<Plan> {
  const exports: Record<string, string> = {};
  for (const [subpath, source] of Object.entries(plan.exports)) {
    if (!source.includes("*")) {
      exports[subpath] = source;
      continue;
    }
    for await (const entry of expandGlob(source, { root: plan.repoRoot, includeDirs: false })) {
      const rel = `./${toPosix(relative(plan.repoRoot, entry.path))}`;
      exports[wildcardSubpath(subpath, source, rel)] = rel;
    }
  }
  return { ...plan, exports };
}

/**
 * Builds the module graph from the plan's entry points using Deno's own resolver, then flattens it into plain
 * {@linkcode RawGraph} data.
 *
 * @example
 * ```ts ignore
 * //  For a project src/mod.ts imports "./util.ts" and "jsr:@std/encoding@1/hex".
 * const graph = await loadGraph(plan);
 *
 * // graph.modules holds one entry per reachable module; each dependency is resolved to its target:
 * //
 * //   file:///repo/src/mod.ts   [TypeScript]
 * //     ./util.ts                -> file:///repo/src/util.ts
 * //     jsr:@std/encoding@1/hex  -> https://jsr.io/@std/encoding/1.0.0/hex.ts
 * //   file:///repo/src/util.ts  [TypeScript]  (no dependencies)
 *
 * await graph.readSource("https://jsr.io/@std/encoding/1.0.0/hex.ts");
 * // -> the module's source bytes
 * ```
 */
export async function loadGraph(plan: Plan): Promise<RawGraph> {
  // A relative import-map target resolves against the import map's own URL — the project's `deno.json`.
  const resolveSpecifier = makeResolver(plan.imports, toFileUrl(join(plan.repoRoot, "deno.json")).href);

  // HACK: `@deno/graph` mutates each LoadResponse it is handed (content becomes a plain number[] for wasm), and the
  // cache memoizes remote responses by object, so a shared instance would replay the mutated content on a later load.
  // The graph gets its own instance; module sources are read through a separate, fresh one.
  const graphCache = createCache();
  const roots = Object.values(plan.exports).map((source) => toFileUrl(resolve(plan.repoRoot, source)).href);
  const graph = await createGraph(roots, {
    load: (specifier) => graphCache.load(specifier),
    resolve: resolveSpecifier,
  });

  // `@deno/graph` records redirects (a versionless or aliased URL → its resolved target) but does not apply them to
  // dependency edges; follow each through the table transitively — a CLI-populated cache stores one entry per hop.
  const follow = (specifier: string | undefined): string | undefined => {
    let current = specifier;
    while (current !== undefined && graph.redirects[current] !== undefined) current = graph.redirects[current];
    return current;
  };
  const modules: RawModule[] = graph.modules.map((m) => ({
    specifier: m.specifier,
    mediaType: m.mediaType,
    error: m.error,
    dependencies: (m.dependencies ?? []).map((d) => ({
      specifier: d.specifier,
      resolved: follow(d.code?.specifier ?? d.type?.specifier),
    })),
  }));

  const sourceCache = createCache();
  const readSource = async (specifier: string): Promise<Uint8Array> => {
    const loaded = await sourceCache.load(specifier);
    if (loaded?.kind !== "module") {
      throw new BuildError("MODULE_LOAD_FAILED", "cannot read module source from the Deno cache", specifier);
    }
    return typeof loaded.content === "string" ? new TextEncoder().encode(loaded.content) : loaded.content;
  };

  return { modules, readSource };
}
