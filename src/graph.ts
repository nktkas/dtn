/**
 * Reads the project through `@deno/graph` and the Deno cache, then flattens the result into plain {@linkcode RawGraph} data.
 *
 * @module
 */

import { createGraph, type MediaType } from "@deno/graph";
import { createCache } from "@deno/cache-dir";
import { resolve, toFileUrl } from "@std/path";
import { BuildError } from "./errors.ts";
import { makeResolver } from "./spec.ts";
import type { Plan } from "./intake.ts";

/**
 * A graph edge: the specifier as written, and what Deno resolves it to (after redirects).
 *
 * @see https://jsr.io/@deno/graph/doc/types/~/DependencyJson
 * @see https://jsr.io/@deno/graph/doc/~/ModuleGraphJson
 */
export interface RawDependency {
  specifier: string;
  resolved: string | undefined;
}

/**
 * A module's media type: the string values of `@deno/graph`'s `MediaType` enum, without its runtime object.
 *
 * @see https://jsr.io/@deno/graph/doc/~/MediaType
 */
export type RawMediaType = `${MediaType}`;

/**
 * A graph module. `mediaType` is absent for npm and failed modules.
 *
 * @see https://jsr.io/@deno/graph/doc/~/ModuleJson
 */
export interface RawModule {
  specifier: string;
  mediaType: RawMediaType | undefined;
  error: string | undefined;
  dependencies: RawDependency[];
}

/**
 * The flattened module graph plus Deno-cache source access.
 *
 * @see https://jsr.io/@deno/graph/doc/~/ModuleGraphJson
 * @see https://jsr.io/@deno/cache-dir/doc/~/Loader
 */
export interface RawGraph {
  modules: RawModule[];
  /**
   * Reads a module's source bytes from the Deno cache.
   *
   * @throws {BuildError} `DEPENDENCY_FAILED` when the entry is not a loadable module.
   */
  readSource(specifier: string): Promise<Uint8Array>;
}

/**
 * Builds the module graph from the plan's entry points using Deno's own resolver, then flattens it into plain {@linkcode RawGraph} data.
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
 *
 * @see https://jsr.io/@deno/graph/doc/~/createGraph
 * @see https://jsr.io/@deno/cache-dir/doc/~/createCache
 */
export async function loadGraph(plan: Plan): Promise<RawGraph> {
  const resolveSpecifier = makeResolver(plan.imports);

  const graphCache = createCache();
  const roots = Object.values(plan.exports).map((source) => toFileUrl(resolve(plan.repoRoot, source)).href);
  const graph = await createGraph(roots, {
    load: (specifier) => graphCache.load(specifier),
    resolve: resolveSpecifier,
  });

  const fragmentTarget = (specifier: string): string | undefined => {
    const hash = specifier.indexOf("#");
    if (hash === -1) return undefined;
    const target = graph.redirects[specifier];
    return target === specifier.slice(0, hash) ? target : undefined;
  };

  // `@deno/graph` models URL fragments as redirects even though Deno gives each fragment its own module instance.
  // Preserve those aliases while following actual redirects transitively.
  const follow = (specifier: string | undefined): string | undefined => {
    let current = specifier;
    while (
      current !== undefined && graph.redirects[current] !== undefined && fragmentTarget(current) === undefined
    ) current = graph.redirects[current];
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
  const moduleBySpecifier = new Map(modules.map((module) => [module.specifier, module]));
  for (const alias of Object.keys(graph.redirects)) {
    const target = fragmentTarget(alias);
    if (target === undefined) continue;
    modules.push({ ...moduleBySpecifier.get(target)!, specifier: alias });
  }

  // HACK:
  // @deno/graph mutates loader responses while flattening modules,
  // so a fresh cache reader prevents those mutated plain arrays from reaching TextDecoder during the vendor stage.
  const sourceCache = createCache();
  const readSource = async (specifier: string): Promise<Uint8Array> => {
    let loaded;
    try {
      loaded = await sourceCache.load(specifier);
    } catch (cause) {
      throw new BuildError("DEPENDENCY_FAILED", "cannot read module source from the Deno cache", {
        subject: specifier,
        cause,
      });
    }
    if (loaded?.kind !== "module") {
      throw new BuildError("DEPENDENCY_FAILED", "cannot read module source from the Deno cache", {
        subject: specifier,
      });
    }
    return typeof loaded.content === "string" ? new TextEncoder().encode(loaded.content) : loaded.content;
  };

  return { modules, readSource };
}
