/**
 * Classifies the reachable graph into package artifacts, npm dependencies, and referrer-specific specifier bindings.
 *
 * @module
 */

import { common, dirname, fromFileUrl, relative } from "@std/path";
import { BuildError } from "./errors.ts";
import type { Plan } from "./intake.ts";
import type { RawGraph, RawMediaType, RawModule } from "./graph.ts";
import { isRelative, parseRegistry, parseReplacement, toPosix, tsToJs, vendoredRel } from "./spec.ts";

// =============================================================================
// Classification
// =============================================================================

/** Local source media copied into the package instead of being transpiled. */
const COPY_MEDIA: ReadonlySet<RawMediaType> = new Set(["JavaScript", "Mjs", "Dts", "Json"]);

/** Remote media copied and rewritten without transpilation. */
const VENDOR_COPY_MEDIA: ReadonlySet<RawMediaType> = new Set(["JavaScript", "Mjs", "Dts"]);

/** What becomes of one reachable graph module. */
type Fate =
  | { kind: "transpile"; path: string }
  | { kind: "copy"; path: string }
  | { kind: "vendorCode"; url: string; src: string; emit: string }
  | { kind: "vendorCopy"; url: string; rel: string }
  | { kind: "external"; npm: { name: string; version: string } | null };

/** One resolved graph edge's package target. */
type SpecTarget =
  | { kind: "vendored"; src: string; emit: string }
  | { kind: "local"; emit: string; suffix: string }
  | { kind: "npm"; bare: string; registry: string };

/** An import-map alias bound to an npm package. */
interface AliasBinding {
  alias: string;
  npmName: string;
  /** Subpath carried by the configured registry target, including its leading slash. */
  subpath: string;
  version: string;
}

/** Import map passed to one declaration-emitting subprocess. */
interface DeclarationImportMap {
  imports: Record<string, string>;
  scopes: Record<string, Record<string, string>>;
}

/** The analyzed build plan consumed by the effectful stages. */
export interface Analysis {
  plan: Plan;
  /** Common ancestor directory of every local source. */
  srcRoot: string;
  /** Absolute local TypeScript paths passed to `deno transpile`. */
  localFiles: string[];
  /** Absolute local JavaScript/MJS/declaration paths copied verbatim. */
  localCopies: string[];
  /** Remote TypeScript URL to staged source and emitted JavaScript paths. */
  vendoredCode: Map<string, { src: string; emit: string }>;
  /** Remote JavaScript/MJS/declaration URL to copied package path. */
  vendoredCopies: Map<string, string>;
  /** Emitted package-relative module path to its original graph referrer. */
  sourceByOutput: Map<string, string>;
  /** npm package name to version requirement. */
  npmDeps: Record<string, string>;
  specifiers: SpecifierIndex;
}

/**
 * Classifies every module reachable from the entry points.
 *
 * @throws {BuildError} `UNSUPPORTED_MODULE` for an unsupported local or remote medium.
 * @throws {BuildError} `DEPENDENCY_FAILED` when a module cannot be loaded or an edge cannot become package output.
 */
export function analyze(plan: Plan, graph: RawGraph): Analysis {
  const npmDeps = new Map<string, string>();
  const recordNpmDependency = (name: string, version: string): void => {
    const existing = npmDeps.get(name);
    if (existing !== undefined && existing !== version) {
      const requirements = [existing, version].sort().map((requirement) => JSON.stringify(requirement));
      throw new BuildError(
        "DEPENDENCY_FAILED",
        `npm package has conflicting version requirements ${requirements[0]} and ${requirements[1]}`,
        { subject: name },
      );
    }
    npmDeps.set(name, version);
  };
  const aliases: AliasBinding[] = [];
  const importAliases = Object.keys(plan.imports).sort((a, b) => b.length - a.length);

  for (const [alias, replacement] of Object.entries(plan.npmReplacements)) {
    const parsedReplacement = parseReplacement(replacement);
    if (parsedReplacement === null) {
      throw new BuildError("INVALID_CONFIG", "npmReplacements value is not an npm package name", { subject: alias });
    }
    const parsedTarget = parseRegistry(plan.imports[alias]);
    const version = parsedReplacement.version ?? parsedTarget?.version ?? "*";
    recordNpmDependency(parsedReplacement.name, version);
    aliases.push({ alias, npmName: parsedReplacement.name, subpath: parsedTarget?.subpath ?? "", version });
  }

  for (const [alias, specifier] of Object.entries(plan.imports)) {
    if (Object.hasOwn(plan.npmReplacements, alias)) continue;
    const target = parseRegistry(specifier);
    if (target?.scheme !== "npm") continue;
    const version = target.version ?? "*";
    recordNpmDependency(target.pkg, version);
    aliases.push({ alias, npmName: target.pkg, subpath: target.subpath, version });
  }

  const modules = new Map(graph.modules.map((module) => [module.specifier, module] as const));
  const fates = new Map<string, Fate>();
  const reachable: Array<{ module: RawModule; fate: Exclude<Fate, { kind: "external" }> }> = [];
  const seen = new Set<string>();
  const queue = graph.modules.filter((module) => module.specifier.startsWith("file://")).map((module) =>
    module.specifier
  );

  while (queue.length > 0) {
    const specifier = queue.pop()!;
    if (seen.has(specifier)) continue;
    seen.add(specifier);

    const module = modules.get(specifier);
    if (module === undefined) {
      throw new BuildError("DEPENDENCY_FAILED", "resolved module is absent from the graph", { subject: specifier });
    }
    const fate = fateOf(module, plan.depsDir);
    fates.set(specifier, fate);
    if (fate.kind === "external") {
      if (fate.npm !== null) recordNpmDependency(fate.npm.name, fate.npm.version);
      continue;
    }

    reachable.push({ module, fate });
    for (const dependency of module.dependencies) {
      const alias = matchingAlias(dependency.specifier, importAliases);
      if (alias !== null && Object.hasOwn(plan.npmReplacements, alias)) continue;
      if (dependency.resolved !== undefined && !seen.has(dependency.resolved)) queue.push(dependency.resolved);
    }
  }

  const localFiles = new Set<string>();
  const localCopies = new Set<string>();
  const vendoredCode = new Map<string, { src: string; emit: string }>();
  const vendoredCopies = new Map<string, string>();
  for (const { fate } of reachable) {
    if (fate.kind === "transpile") localFiles.add(fate.path);
    if (fate.kind === "copy") localCopies.add(fate.path);
    if (fate.kind === "vendorCode") vendoredCode.set(fate.url, { src: fate.src, emit: fate.emit });
    if (fate.kind === "vendorCopy") vendoredCopies.set(fate.url, fate.rel);
  }

  const allLocal = [...localFiles, ...localCopies];
  const srcRoot = common(allLocal.map((path) => dirname(path))).replace(/[/\\]$/, "");
  const targets = new Map<string, SpecTarget>();
  const sourceByOutput = new Map<string, string>();
  for (const { module, fate } of reachable) {
    if (fate.kind === "transpile" || fate.kind === "copy") {
      const rel = toPosix(relative(srcRoot, fate.path));
      const emit = fate.kind === "transpile" ? tsToJs(rel) : rel;
      const url = new URL(module.specifier);
      targets.set(module.specifier, { kind: "local", emit, suffix: url.search + url.hash });
      sourceByOutput.set(emit, module.specifier);
      if (fate.kind === "transpile") sourceByOutput.set(emit.replace(/\.js$/, ".d.ts"), module.specifier);
      continue;
    }
    if (fate.kind === "vendorCode") {
      const target = { kind: "vendored", src: fate.src, emit: fate.emit } as const;
      targets.set(module.specifier, target);
      sourceByOutput.set(fate.emit, module.specifier);
      sourceByOutput.set(fate.emit.replace(/\.js$/, ".d.ts"), module.specifier);
      continue;
    }
    targets.set(module.specifier, { kind: "vendored", src: fate.rel, emit: fate.rel });
    sourceByOutput.set(fate.rel, module.specifier);
  }

  const edges = new Map<string, Map<string, SpecTarget>>();
  for (const { module } of reachable) {
    const moduleEdges = new Map<string, SpecTarget>();
    edges.set(module.specifier, moduleEdges);
    for (const dependency of module.dependencies) {
      if (dependency.resolved === undefined) continue;
      const target = npmTarget(dependency.specifier, dependency.resolved, importAliases, aliases) ??
        targets.get(dependency.resolved) ?? null;
      if (target !== null) moduleEdges.set(dependency.specifier, target);
    }
  }

  const npmDepsRecord = Object.fromEntries(npmDeps);
  const vendorSources = new Map<string, string>([
    ...[...vendoredCode].map(([url, { src }]) => [url, src] as const),
    ...vendoredCopies,
  ]);
  const specifiers = new SpecifierIndex({ edges, aliases, vendorSources, npmDeps: npmDepsRecord });
  validateSpecifiers(reachable, specifiers);

  return {
    plan,
    srcRoot,
    localFiles: [...localFiles],
    localCopies: [...localCopies],
    vendoredCode,
    vendoredCopies,
    sourceByOutput,
    npmDeps: npmDepsRecord,
    specifiers,
  };
}

/** Classifies one graph module without inspecting its outgoing edges. */
function fateOf(module: RawModule, depsDir: string): Fate {
  const media = module.mediaType;
  if (module.specifier.startsWith("file://")) {
    const path = fromFileUrl(module.specifier);
    if (module.error !== undefined) {
      throw new BuildError("DEPENDENCY_FAILED", module.error, { subject: path });
    }
    if (media === "TypeScript") return { kind: "transpile", path };
    if (media !== undefined && COPY_MEDIA.has(media)) return { kind: "copy", path };
    throw new BuildError("UNSUPPORTED_MODULE", `local module has unsupported media type ${media}`, { subject: path });
  }

  if (module.specifier.startsWith("npm:")) {
    const npm = parseRegistry(module.specifier);
    return { kind: "external", npm: npm === null ? null : { name: npm.pkg, version: npm.version ?? "*" } };
  }
  if (module.specifier.startsWith("node:")) return { kind: "external", npm: null };

  if (module.error !== undefined) {
    throw new BuildError("DEPENDENCY_FAILED", module.error, { subject: module.specifier });
  }
  if (media === "TypeScript") {
    const src = vendoredRel(module.specifier, depsDir, media);
    return { kind: "vendorCode", url: module.specifier, src, emit: tsToJs(src) };
  }
  if (media !== undefined && VENDOR_COPY_MEDIA.has(media)) {
    return {
      kind: "vendorCopy",
      url: module.specifier,
      rel: vendoredRel(module.specifier, depsDir, media as "JavaScript" | "Mjs" | "Dts"),
    };
  }
  throw new BuildError("UNSUPPORTED_MODULE", `remote module has unsupported media type ${media}`, {
    subject: module.specifier,
  });
}

/** Resolves an external edge to its npm package form. */
function npmTarget(
  written: string,
  resolved: string,
  importAliases: string[],
  aliases: AliasBinding[],
): SpecTarget | null {
  const alias = matchingAlias(written, importAliases);
  if (alias !== null) {
    const binding = aliases.find((candidate) => candidate.alias === alias);
    if (binding !== undefined) {
      const subpath = binding.subpath + written.slice(alias.length);
      return {
        kind: "npm",
        bare: binding.npmName + subpath,
        registry: `npm:${binding.npmName}@${binding.version}${subpath}`,
      };
    }
  }

  const registry = parseRegistry(resolved);
  if (registry?.scheme === "npm") {
    return {
      kind: "npm",
      bare: registry.pkg + registry.subpath,
      registry: `npm:${registry.pkg}@${registry.version ?? "*"}${registry.subpath}`,
    };
  }
  return null;
}

/** The exact or longest-prefix Deno package alias matching a written specifier. */
function matchingAlias(specifier: string, aliases: string[]): string | null {
  if (aliases.includes(specifier)) return specifier;
  return aliases.find((alias) => specifier.startsWith(alias.endsWith("/") ? alias : `${alias}/`)) ?? null;
}

/** Fails before output is removed when a graph edge has no supported package target. */
function validateSpecifiers(
  reachable: Array<{ module: RawModule; fate: Exclude<Fate, { kind: "external" }> }>,
  specifiers: SpecifierIndex,
): void {
  for (const { module } of reachable) {
    for (const dependency of module.dependencies) {
      if (specifiers.resolve(module.specifier, dependency.specifier) !== null) continue;
      if (dependency.specifier.startsWith("node:")) continue;
      throw new BuildError("DEPENDENCY_FAILED", "specifier has no supported package target", {
        subject: dependency.specifier,
      });
    }
  }
}

// =============================================================================
// Specifier index
// =============================================================================

/** Constructor data for {@linkcode SpecifierIndex}. */
interface SpecifierIndexInput {
  edges?: Map<string, Map<string, SpecTarget>>;
  aliases: AliasBinding[];
  vendorSources?: Map<string, string>;
  npmDeps: Record<string, string>;
}

/** Resolves module specifiers by graph edge and builds the two declaration-pass import maps. */
export class SpecifierIndex {
  private readonly _edges: Map<string, Map<string, SpecTarget>>;
  private readonly _aliases: AliasBinding[];
  private readonly _vendorSources: Map<string, string>;
  private readonly _npmDeps: Record<string, string>;

  constructor(input: SpecifierIndexInput) {
    this._edges = input.edges ?? new Map();
    this._aliases = input.aliases;
    this._vendorSources = input.vendorSources ?? new Map();
    this._npmDeps = input.npmDeps;
  }

  /** Resolves the specifier written by one concrete graph referrer. */
  resolve(referrer: string, specifier: string): SpecTarget | null {
    return this._edges.get(referrer)?.get(specifier) ?? null;
  }

  /** Import map used while declarations are emitted from local sources. */
  declarationImportMap(): DeclarationImportMap {
    const map = new Map<string, string>();
    for (const { alias, npmName, subpath, version } of this._aliases) {
      map.set(alias, `npm:${npmName}@${version}${subpath}`);
    }
    for (const [referrer, edges] of this._edges) {
      if (!referrer.startsWith("file://")) continue;
      for (const [specifier, target] of edges) {
        if (target.kind === "npm" && !specifier.startsWith("npm:")) map.set(specifier, target.registry);
        if (!isRelative(specifier) && target.kind === "vendored" && !map.has(specifier)) {
          map.set(specifier, `./${target.src}`);
        }
      }
    }
    return { imports: Object.fromEntries(map), scopes: this._vendorScopes() };
  }

  /** Import map used while declarations are emitted from vendored remote sources. */
  vendorImportMap(): DeclarationImportMap {
    const map = new Map(Object.entries(this._npmDeps).map(([name, version]) => [name, `npm:${name}@${version}`]));
    return { imports: Object.fromEntries(map), scopes: this._vendorScopes() };
  }

  /** Per-source npm mappings for staged vendored modules. */
  private _vendorScopes(): Record<string, Record<string, string>> {
    const scopes = new Map<string, Record<string, string>>();
    for (const [referrer, edges] of this._edges) {
      const source = this._vendorSources.get(referrer);
      if (source === undefined) continue;
      const imports = new Map<string, string>();
      for (const target of edges.values()) {
        if (target.kind === "npm") imports.set(target.bare, target.registry);
      }
      if (imports.size > 0) scopes.set(`./${source}`, Object.fromEntries(imports));
    }
    return Object.fromEntries(scopes);
  }
}
