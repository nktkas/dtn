/**
 * Classifies every reachable module of the graph into one {@linkcode Analysis}: each module's
 * {@linkcode Fate}, the npm dependency set, and the {@linkcode SpecifierIndex}.
 *
 * @module
 */

import { common, dirname, fromFileUrl, relative } from "@std/path";
import { BuildError } from "./errors.ts";
import type { Plan } from "./intake.ts";
import type { RawGraph, RawMediaType, RawModule } from "./graph.ts";
import { isRelative, jsrUrlPackage, parseRegistry, parseReplacement, toPosix, tsToJs, vendoredRel } from "./spec.ts";

// =============================================================================
// Classification
// =============================================================================

/** Local source media types copied into the package verbatim instead of being transpiled. */
const COPY_MEDIA: ReadonlySet<RawMediaType> = new Set(["JavaScript", "Mjs", "Cjs", "Json", "Dts", "Wasm"]);

/** Remote media types vendored as raw byte assets instead of being transpiled. */
const ASSET_MEDIA: ReadonlySet<RawMediaType> = new Set(["Json", "Wasm"]);

/** Remote media inlined verbatim — rewritten for Node, not transpiled: JavaScript modules and type declarations. */
const VENDOR_COPY_MEDIA: ReadonlySet<RawMediaType> = new Set(["JavaScript", "Mjs", "Cjs", "Dts"]);

/** What becomes of a single reachable module. */
type Fate =
  | { kind: "transpile"; path: string } // local `.ts` → deno transpile
  | { kind: "copy"; path: string } // local `.js`/`.mjs`/`.cjs`/`.json`/`.d.ts` → copied verbatim
  | { kind: "vendorCode"; url: string; src: string; emit: string } // remote `.ts` → staged at `src`, transpiled to `emit`
  | { kind: "vendorCopy"; url: string; rel: string } // remote `.js`/`.mjs`/`.cjs`/`.d.ts` → inlined, rewritten, not transpiled
  | { kind: "vendorAsset"; url: string; rel: string } // remote JSON/Wasm → copied byte-for-byte
  | { kind: "external"; npm: { name: string; version: string } | null }; // npm/node/replaced → no emit, a graph leaf

/** The single result of analysis. Each later stage reads only the slice it needs. */
export interface Analysis {
  plan: Plan;
  /** Common ancestor directory of all local sources; the package code root mirrors the tree below it. */
  srcRoot: string;
  /** Absolute paths of local `.ts` sources to transpile. */
  localFiles: string[];
  /** Absolute paths of local non-`.ts` sources copied verbatim. */
  localCopies: string[];
  /** Remote code-module URL → its staged `.ts` source and emitted `.js` path, both package-relative. */
  vendoredCode: Map<string, { src: string; emit: string }>;
  /** Remote JavaScript or type-declaration URL → package-relative path (copied verbatim and rewritten, not transpiled). */
  vendoredCopies: Map<string, string>;
  /** Remote asset URL → package-relative path (copied byte-for-byte). */
  vendoredAssets: Map<string, string>;
  /** npm dependency name → version range, for `package.json` `dependencies`. */
  npmDeps: Record<string, string>;
  specifiers: SpecifierIndex;
}

/**
 * Classifies every module reachable from the entry points (not through a replaced package), producing the {@linkcode Analysis}.
 *
 * @throws {BuildError} `UNSUPPORTED_LOCAL_SOURCE` for a local source whose media type the engine does not handle.
 * @throws {BuildError} `UNSUPPORTED_VENDORED_DEPENDENCY` for a vendored dependency the engine cannot inline (an
 *                       unsupported media type, or a hostless URL like `data:`).
 * @throws {BuildError} `MODULE_LOAD_FAILED` for a module the graph could not load.
 * @throws {BuildError} `REPLACEMENT_DIRECT_IMPORT` for a replaced package imported directly by local code.
 * @throws {BuildError} `UNRESOLVED_SPECIFIER` for a specifier resolving to neither a vendored file nor an npm package.
 *
 * @example
 * ```ts ignore
 * // For a project whose src/mod.ts imports:
 * //   "@valibot/valibot"  (jsr, replaced by the npm package "valibot")
 * //   "@std/encoding/hex" (jsr, no npm twin -> vendored)
 * //   "./util.ts"         (local)
 * const analysis = analyze(plan, graph);
 *
 * // analysis.localFiles   -> ["/repo/src/mod.ts", "/repo/src/util.ts"]
 * // analysis.npmDeps      -> { valibot: "1.3.1" }
 * // analysis.vendoredCode -> Map {
 * //   "https://jsr.io/@std/encoding/1.0.0/hex.ts" =>
 * //     { src: "_deps/jsr.io/@std/encoding/1.0.0/hex.ts", emit: "_deps/jsr.io/@std/encoding/1.0.0/hex.js" },
 * // }
 * ```
 */
export function analyze(plan: Plan, graph: RawGraph): Analysis {
  const npmDeps: Record<string, string> = {};
  const aliases: AliasBinding[] = [];
  const replacedJsrPackages = new Map<string, string>();

  // Replaced dependencies: the npm name (and optional version) come from the replacement value; the subpath, and
  // the version when the replacement omits it, come from the alias's jsr/npm import (validated at intake).
  for (const [alias, replacement] of Object.entries(plan.npmReplacements)) {
    const { name: npmName, version: explicitVersion } = parseReplacement(replacement);
    const parsed = parseRegistry(plan.imports[alias]);
    const version = explicitVersion ?? parsed?.version ?? "*";
    npmDeps[npmName] = version;
    aliases.push({ alias, npmName, subpath: parsed?.subpath ?? "", version });
    if (parsed?.scheme === "jsr") replacedJsrPackages.set(parsed.pkg, npmName);
  }

  // Direct npm: imports from the import map.
  for (const [alias, spec] of Object.entries(plan.imports)) {
    if (alias in plan.npmReplacements) continue;
    const npm = parseRegistry(spec);
    if (npm === null || npm.scheme !== "npm") continue;
    const version = npm.version ?? "*";
    npmDeps[npm.pkg] = version;
    aliases.push({ alias, npmName: npm.pkg, subpath: npm.subpath, version });
  }

  // Walk the graph from the entry points, treating npm/node/replaced modules as leaves. Anything reachable only
  // through a replaced package is never visited, so it is neither vendored nor type-checked.
  const bySpecifier = new Map(graph.modules.map((m) => [m.specifier, m] as const));
  const reachable: Array<{ module: RawModule; fate: Fate }> = [];
  const seen = new Set<string>();
  const queue = graph.modules.filter((m) => m.specifier.startsWith("file://")).map((m) => m.specifier);

  while (queue.length > 0) {
    const specifier = queue.pop()!;
    if (seen.has(specifier)) continue;
    seen.add(specifier);

    const module = bySpecifier.get(specifier)!;

    const fate = fateOf(module, replacedJsrPackages, plan.depsDir);
    if (fate.kind === "external") {
      // `??=`: first walk-hit wins — one version per npm package, picked by entry-point order on a collision.
      if (fate.npm !== null) npmDeps[fate.npm.name] ??= fate.npm.version;
      continue;
    }
    reachable.push({ module, fate });
    for (const d of module.dependencies) {
      if (d.resolved !== undefined && !seen.has(d.resolved)) queue.push(d.resolved);
    }
  }

  const localFiles: string[] = [];
  const localCopies: string[] = [];
  const vendoredCode = new Map<string, { src: string; emit: string }>();
  const vendoredCopies = new Map<string, string>();
  const vendoredAssets = new Map<string, string>();
  const localByUrl = new Map<string, string>();
  for (const { module, fate } of reachable) {
    if (fate.kind === "transpile") {
      localFiles.push(fate.path);
      localByUrl.set(module.specifier, fate.path);
    }
    if (fate.kind === "copy") {
      localCopies.push(fate.path);
      localByUrl.set(module.specifier, fate.path);
    }
    if (fate.kind === "vendorCode") vendoredCode.set(fate.url, { src: fate.src, emit: fate.emit });
    if (fate.kind === "vendorCopy") vendoredCopies.set(fate.url, fate.rel);
    if (fate.kind === "vendorAsset") vendoredAssets.set(fate.url, fate.rel);
  }

  // `common()` returns a trailing separator when the sources span divergent dirs ("/repo/"); strip it so the package
  // code root mirrors cleanly below srcRoot.
  const allLocal = [...localFiles, ...localCopies];
  const srcRoot = allLocal.length > 0 ? common(allLocal.map((f) => dirname(f))).replace(/[/\\]$/, "") : plan.repoRoot;

  // Bind each written non-relative specifier to the package file it resolves to: a vendored dependency under `_deps`,
  // or — for an import-map alias pointing at a local file (`"$u": "./util.ts"`) — that local source's emitted path.
  // Relative specifiers rewrite by extension only, so they are skipped.
  const vendoredBySpecifier = new Map<string, { src: string; emit: string }>();
  const localBySpecifier = new Map<string, { rel: string; source: string }>();
  for (const { module } of reachable) {
    for (const d of module.dependencies) {
      if (isRelative(d.specifier) || d.resolved === undefined) continue;
      const code = vendoredCode.get(d.resolved);
      if (code !== undefined) {
        vendoredBySpecifier.set(d.specifier, code);
        continue;
      }
      // A copied module or a byte asset is its own source.
      const copied = vendoredCopies.get(d.resolved) ?? vendoredAssets.get(d.resolved);
      if (copied !== undefined) {
        vendoredBySpecifier.set(d.specifier, { src: copied, emit: copied });
        continue;
      }
      const localAbs = localByUrl.get(d.resolved);
      if (localAbs !== undefined) {
        // A local `.d.ts` is copied verbatim (no `.js` twin); any other local source emits `.js`.
        const rel = toPosix(relative(srcRoot, localAbs));
        localBySpecifier.set(d.specifier, { rel: localAbs.endsWith(".d.ts") ? rel : tsToJs(rel), source: d.resolved });
      }
    }
  }

  const specifiers = new SpecifierIndex({
    vendored: vendoredBySpecifier,
    localAliases: localBySpecifier,
    aliases,
    replacedJsrPackages,
    npmDeps,
  });

  validateSpecifiers(reachable, specifiers);

  return { plan, srcRoot, localFiles, localCopies, vendoredCode, vendoredCopies, vendoredAssets, npmDeps, specifiers };
}

/**
 * The fate of one module from its origin and media type.
 *
 * @throws {BuildError} `MODULE_LOAD_FAILED` when the module carries a load error.
 * @throws {BuildError} `UNSUPPORTED_LOCAL_SOURCE` for a local source whose media type the engine does not handle.
 * @throws {BuildError} `UNSUPPORTED_VENDORED_DEPENDENCY` for a vendored dependency the engine cannot inline (an
 *                       unsupported media type, or a hostless URL like `data:`).
 */
function fateOf(module: RawModule, replacedJsrPackages: Map<string, string>, depsDir: string): Fate {
  const media = module.mediaType;

  if (module.specifier.startsWith("file://")) {
    const path = fromFileUrl(module.specifier);
    if (module.error !== undefined) throw new BuildError("MODULE_LOAD_FAILED", module.error, path);
    if (media === "TypeScript") return { kind: "transpile", path };
    if (media !== undefined && COPY_MEDIA.has(media)) return { kind: "copy", path };
    throw new BuildError(
      "UNSUPPORTED_LOCAL_SOURCE",
      `local source has unsupported media type ${media}; expected .ts .js .mjs .cjs .json .d.ts`,
      path,
    );
  }

  // Classified before the load-error check below: @deno/graph stamps an error on every npm: node, so checking error
  // first would wrongly fail every external dependency.
  if (module.specifier.startsWith("npm:")) {
    const npm = parseRegistry(module.specifier);
    return { kind: "external", npm: npm === null ? null : { name: npm.pkg, version: npm.version ?? "*" } };
  }
  if (module.specifier.startsWith("node:")) return { kind: "external", npm: null };

  const pkg = jsrUrlPackage(module.specifier);
  if (pkg !== null && replacedJsrPackages.has(pkg)) return { kind: "external", npm: null };

  if (module.error !== undefined) throw new BuildError("MODULE_LOAD_FAILED", module.error, module.specifier);
  // A vendored module mirrors its remote `host + pathname` under `_deps`; a hostless URL (e.g. `data:`) has neither.
  if (new URL(module.specifier).host === "") {
    throw new BuildError(
      "UNSUPPORTED_VENDORED_DEPENDENCY",
      `a remote dependency without a host cannot be vendored`,
      module.specifier,
    );
  }
  const rel = vendoredRel(module.specifier, depsDir);
  if (media === "TypeScript") {
    // The media type comes from the Content-Type header, not the URL path, so a TypeScript URL may lack an
    // extension — while both the transpiler and the specifier rewriter key on it. Normalize the staged name.
    const src = rel.endsWith(".ts") ? rel : `${rel}.ts`;
    return { kind: "vendorCode", url: module.specifier, src, emit: tsToJs(src) };
  }
  if (media !== undefined && VENDOR_COPY_MEDIA.has(media)) return { kind: "vendorCopy", url: module.specifier, rel };
  if (media !== undefined && ASSET_MEDIA.has(media)) return { kind: "vendorAsset", url: module.specifier, rel };
  throw new BuildError(
    "UNSUPPORTED_VENDORED_DEPENDENCY",
    `vendored dependency has unsupported media type ${media}; expected .ts, .js, or JSON/Wasm`,
    module.specifier,
  );
}

/**
 * Fails the build if any specifier cannot be made Node-resolvable — before a single file is written.
 *
 * @throws {BuildError} `REPLACEMENT_DIRECT_IMPORT` when local code imports a replaced package directly.
 * @throws {BuildError} `UNRESOLVED_SPECIFIER` when a specifier resolves to neither a vendored file nor an npm package.
 */
function validateSpecifiers(reachable: Array<{ module: RawModule }>, specifiers: SpecifierIndex): void {
  for (const { module } of reachable) {
    const local = module.specifier.startsWith("file://");
    for (const d of module.dependencies) {
      if (isRelative(d.specifier)) continue;

      if (local) {
        const conflict = specifiers.replacedJsrConflict(d.specifier);
        if (conflict !== null) {
          throw new BuildError(
            "REPLACEMENT_DIRECT_IMPORT",
            `replaced package "${conflict}" imported directly; import it through its import-map alias instead`,
            d.specifier,
          );
        }
      }

      if (specifiers.resolve(d.specifier) !== null) continue;
      if (d.specifier.startsWith("node:")) continue;
      throw new BuildError(
        "UNRESOLVED_SPECIFIER",
        `specifier resolves to neither a vendored file nor an npm package`,
        d.specifier,
      );
    }
  }
}

// =============================================================================
// Specifier index
// =============================================================================

/** Where a non-relative specifier points once the package is built. */
type SpecTarget =
  | { kind: "vendored"; src: string; emit: string } // a vendored file's staged source and emitted package paths
  | { kind: "local"; rel: string } // package-relative `.js` path of a local file reached via an import-map alias
  | { kind: "npm"; bare: string }; // npm package name with its subpath, e.g. `valibot` or `@std/x/sub`

/** An import-map alias bound to an npm package, split so both the bare name and a `npm:` specifier can be rebuilt. */
interface AliasBinding {
  alias: string;
  npmName: string;
  /** The alias's own subpath (from its import specifier), with a leading slash, or `""`. */
  subpath: string;
  /** Version range for the `npm:` form used by the declaration pass. */
  version: string;
}

/** Everything {@linkcode SpecifierIndex} needs, assembled by `analyze`. */
interface SpecifierIndexInput {
  /** Specifier as written → the vendored module's staged source and emitted paths under the code root. */
  vendored: Map<string, { src: string; emit: string }>;
  /**
   * Import-map alias pointing at a local file → that file's package-relative `.js` path (`rel`) and its real source URL
   * (`source`, for the declaration pass to type-check against).
   */
  localAliases?: Map<string, { rel: string; source: string }>;
  /** Alias bindings, for both replaced jsr packages and direct `npm:` imports. */
  aliases: AliasBinding[];
  /** Replaced jsr package (`@scope/name`) → npm name, for detecting forbidden direct imports. */
  replacedJsrPackages: Map<string, string>;
  /** Every npm dependency name → version range (incl. ones discovered only transitively inside vendored code). */
  npmDeps: Record<string, string>;
}

/**
 * Resolves each non-relative specifier to what it becomes in the built package — a vendored file, a local file reached
 * via an import-map alias, or a bare npm name — and builds the import maps the declaration passes need.
 */
export class SpecifierIndex {
  private readonly _vendored: Map<string, { src: string; emit: string }>;
  private readonly _localAliases: Map<string, { rel: string; source: string }>;
  private readonly _aliases: AliasBinding[];
  private readonly _replacedJsrPackages: Map<string, string>;
  private readonly _npmDeps: Record<string, string>;

  constructor(input: SpecifierIndexInput) {
    this._vendored = input.vendored;
    this._localAliases = input.localAliases ?? new Map();
    // Longest alias first, so `@std/encoding/hex` wins over `@std/encoding`.
    this._aliases = [...input.aliases].sort((a, b) => b.alias.length - a.alias.length);
    this._replacedJsrPackages = input.replacedJsrPackages;
    this._npmDeps = input.npmDeps;
  }

  /**
   * Resolves a non-relative specifier to its package target, or `null` when it needs no rewriting (e.g. `node:`
   * builtins). Relative specifiers are not handled here — the rewriter swaps their extension directly.
   *
   * @example
   * ```ts
   * const index = new SpecifierIndex({
   *   vendored: new Map([
   *     ["@scope/local", { src: "_deps/esm.sh/local/1.0.0/mod.ts", emit: "_deps/esm.sh/local/1.0.0/mod.js" }],
   *   ]),
   *   aliases: [{ alias: "@valibot/valibot", npmName: "valibot", subpath: "", version: "1" }],
   *   replacedJsrPackages: new Map(),
   *   npmDeps: {},
   * });
   *
   * // An import-map alias becomes its real npm name, with the remaining subpath appended:
   * index.resolve("@valibot/valibot/schemas");
   * // -> { kind: "npm", bare: "valibot/schemas" }
   *
   * // A raw npm: specifier is parsed — even one the index never saw (chalk); the scheme and version are dropped:
   * index.resolve("npm:chalk@^5/foo");
   * // -> { kind: "npm", bare: "chalk/foo" }
   *
   * // A written specifier bound to a vendored dependency is looked up to its staged and emitted paths:
   * index.resolve("@scope/local");
   * // -> { kind: "vendored", src: "_deps/esm.sh/local/1.0.0/mod.ts", emit: "_deps/esm.sh/local/1.0.0/mod.js" }
   * ```
   */
  resolve(specifier: string): SpecTarget | null {
    const vendored = this._vendored.get(specifier);
    if (vendored !== undefined) return { kind: "vendored", ...vendored };

    const local = this._localAliases.get(specifier);
    if (local !== undefined) return { kind: "local", rel: local.rel };

    for (const { alias, npmName, subpath } of this._aliases) {
      if (specifier === alias) return { kind: "npm", bare: npmName + subpath };
      const prefix = alias.endsWith("/") ? alias : `${alias}/`;
      if (specifier.startsWith(prefix)) {
        return { kind: "npm", bare: npmName + subpath + specifier.slice(alias.length) };
      }
    }

    const reg = parseRegistry(specifier);
    if (reg !== null) {
      if (reg.scheme === "npm") return { kind: "npm", bare: reg.pkg + reg.subpath };
      // A directly-written jsr specifier for a replaced package: rewritten to npm. Legitimate only inside vendored
      // third-party code; for local code this is a contract error caught earlier by `replacedJsrConflict`.
      const npmName = this._replacedJsrPackages.get(reg.pkg);
      if (npmName !== undefined) return { kind: "npm", bare: npmName + reg.subpath };
    }

    return null;
  }

  /**
   * The npm name a directly-written jsr specifier collides with, or `null`. A non-null result is a contract error.
   *
   * @example
   * ```ts
   * const index = new SpecifierIndex({
   *   vendored: new Map(),
   *   aliases: [],
   *   replacedJsrPackages: new Map([["@valibot/valibot", "valibot"]]),
   *   npmDeps: {},
   * });
   *
   * // A replaced package imported by its raw jsr specifier -> its npm name (forbidden in local code):
   * index.replacedJsrConflict("jsr:@valibot/valibot@1");
   * // -> "valibot"
   *
   * // An unreplaced package, or a non-jsr specifier -> null:
   * index.replacedJsrConflict("jsr:@std/encoding");
   * // -> null
   * ```
   */
  replacedJsrConflict(specifier: string): string | null {
    const parsed = parseRegistry(specifier);
    const pkg = (parsed?.scheme === "jsr" ? parsed.pkg : null) ?? jsrUrlPackage(specifier);
    return pkg === null ? null : (this._replacedJsrPackages.get(pkg) ?? null);
  }

  /**
   * Import map for the local declaration pass: every non-relative specifier a local source may write, mapped to a
   * local `.ts` (vendored), the real source URL (a local-file alias), or a `npm:` specifier (replaced/direct), so the
   * type-checker never hits a remote URL.
   *
   * @example
   * ```ts
   * const index = new SpecifierIndex({
   *   vendored: new Map([
   *     ["@remote/x", { src: "_deps/esm.sh/x/1.0.0/mod.ts", emit: "_deps/esm.sh/x/1.0.0/mod.js" }],
   *   ]),
   *   localAliases: new Map([["$u", { rel: "util.js", source: "file:///repo/src/util.ts" }]]),
   *   aliases: [{ alias: "@valibot/valibot", npmName: "valibot", subpath: "", version: "1" }],
   *   replacedJsrPackages: new Map(),
   *   npmDeps: {},
   * });
   *
   * index.declarationImportMap();
   * // -> {
   * //   "@valibot/valibot": "npm:valibot@1",
   * //   "@remote/x": "./_deps/esm.sh/x/1.0.0/mod.ts",
   * //   "$u": "file:///repo/src/util.ts",
   * // }
   * ```
   */
  declarationImportMap(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const { alias, npmName, subpath, version } of this._aliases) {
      map[alias] = `npm:${npmName}@${version}${subpath}`;
    }
    for (const [specifier, { src }] of this._vendored) {
      map[specifier] ??= `./${src}`;
    }
    for (const [specifier, { source }] of this._localAliases) {
      map[specifier] ??= source;
    }
    return map;
  }

  /**
   * Import map for the vendored declaration pass: every npm dependency name → its `npm:` specifier, so vendored
   * third-party code keeps types even for bare npm imports discovered only transitively.
   *
   * @example
   * ```ts
   * const index = new SpecifierIndex({
   *   vendored: new Map(),
   *   aliases: [],
   *   replacedJsrPackages: new Map(),
   *   npmDeps: { valibot: "1.3.1", chalk: "^5" },
   * });
   *
   * index.vendorImportMap();
   * // -> { valibot: "npm:valibot@1.3.1", chalk: "npm:chalk@^5" }
   * ```
   */
  vendorImportMap(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const [name, version] of Object.entries(this._npmDeps)) {
      map[name] = `npm:${name}@${version}`;
    }
    return map;
  }
}
