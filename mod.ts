/**
 * Builds a Deno library into an npm package, using `deno info` for resolution and `tsc` for emit.
 *
 * Permissions:
 * - `--allow-read` — the project's sources, Deno's module cache and the types `deno install` places.
 * - `--allow-write` — the output directory, and a temporary directory holding the config handed to `deno info`.
 * - `--allow-run=deno`:
 *   - `deno info` for the module graph.
 *   - `deno install` for the npm dependencies.
 * - `--allow-env=TSC_*,NODE_*,DENO_*,HOME,VSCODE_INSPECTOR_OPTIONS` — the names `tsc` reads as it loads, and the
 *   ones that lead to Deno's cache, which a WebAssembly module is documented out of.
 *
 * @example
 * ```ts
 * // deno.json
 * // {
 * //   "name": "@scope/lib",
 * //   "version": "1.0.0",
 * //   "exports": "./src/mod.ts",
 * //   "imports": {
 * //     "@valibot/valibot": "jsr:@valibot/valibot@^1",
 * //     "@std/encoding/hex": "jsr:@std/encoding@^1/hex"
 * //   }
 * // }
 *
 * import { build } from "@nktkas/dtn";
 * import denoJson from "./deno.json" with { type: "json" };
 *
 * await build({
 *   outDir: "dist",
 *   denoJson,
 *   npmReplacements: { "@valibot/valibot": "valibot" },
 * });
 *
 * // dist/
 * // ├── package.json  (generated fields, "valibot" among the dependencies)
 * // ├── tsconfig.json
 * // └── esm/
 * //     ├── mod.js  (+ mod.js.map, mod.d.ts)
 * //     ├── _deps/jsr.io/@std/encoding/1.0.0/hex.js  (+ hex.js.map, hex.d.ts)
 * //     └── ...  (other local files related to mod.js)
 * ```
 *
 * @module
 */

import { builtinModules } from "node:module";
import { doc, type TsTypeDef } from "@deno/doc";
import { lastIndexOfNeedle } from "@std/bytes";
import { distinct, mapEntries, mapValues, partition } from "@std/collections";
import * as fs from "@std/fs";
import * as paths from "@std/path";
import { formatRange, rangeIntersects, tryParseRange } from "@std/semver";
import sortPackageJson from "sort-package-json";
import ts from "typescript";

// =====================================================================================================================
// Public API
// =====================================================================================================================

/** The category of a {@linkcode BuildError}. */
export type BuildErrorCode =
  | "INVALID_CONFIG"
  | "DEPENDENCY_FAILED"
  | "EMIT_FAILED"
  | "UNSHIPPABLE_PACKAGE"
  | "IO_FAILED"
  | "UNKNOWN_ERROR";

/**
 * A build failure carrying a machine-readable category.
 *
 * @example
 * ```ts
 * import { build, BuildError } from "@nktkas/dtn";
 * import denoJson from "./deno.json" with { type: "json" };
 *
 * try {
 *   await build({ outDir: "dist", denoJson });
 * } catch (e) {
 *   if (e instanceof BuildError && e.code === "INVALID_CONFIG") console.error(e.message);
 * }
 * ```
 */
export class BuildError extends Error {
  /** The name every instance carries. */
  override readonly name = "BuildError";
  /** The category of the failure. */
  readonly code: BuildErrorCode;

  /**
   * A failure of the given category, whose message is the one written here with no code spliced into it.
   *
   * @param code The category of the failure.
   * @param message What went wrong, in one sentence.
   * @param cause The error this one was raised from, for a failure the build did not detect itself.
   */
  constructor(code: BuildErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.code = code;
  }
}

/** Options of {@linkcode build}. */
export interface BuildOptions {
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

/**
 * Emits `<outDir>` as a publishable npm package.
 *
 * @param options The project config and everything around it.
 *
 * @returns Nothing. The package is left on disk at {@linkcode BuildOptions.outDir}.
 *
 * @throws {BuildError} `INVALID_CONFIG` when the project's imports, versions and installed packages disagree.
 * @throws {BuildError} `DEPENDENCY_FAILED` when a `deno` command fails, or reports a module it could not load.
 * @throws {BuildError} `EMIT_FAILED` when `tsc` refuses to produce the package's modules and declarations.
 * @throws {BuildError} `UNSHIPPABLE_PACKAGE` when the modules resolve but the package they would make cannot load.
 * @throws {BuildError} `IO_FAILED` when the file system or the runtime refuses the build something, carrying it as `cause`.
 * @throws {BuildError} `UNKNOWN_ERROR` when the build breaks on anything else, carrying it as `cause`.
 *
 * @example
 * ```ts
 * // deno.json
 * // {
 * //   "name": "@scope/lib",
 * //   "version": "1.0.0",
 * //   "exports": "./src/mod.ts",
 * //   "imports": {
 * //     "@valibot/valibot": "jsr:@valibot/valibot@^1",
 * //     "@std/encoding/hex": "jsr:@std/encoding@^1/hex"
 * //   }
 * // }
 *
 * import { build } from "@nktkas/dtn";
 * import denoJson from "./deno.json" with { type: "json" };
 *
 * await build({
 *   outDir: "dist",
 *   denoJson,
 *   npmReplacements: { "@valibot/valibot": "valibot" },
 * });
 *
 * // dist/
 * // ├── package.json  (generated fields, "valibot" among the dependencies)
 * // ├── tsconfig.json
 * // └── esm/
 * //     ├── mod.js  (+ mod.js.map, mod.d.ts)
 * //     ├── _deps/jsr.io/@std/encoding/1.0.0/hex.js  (+ hex.js.map, hex.d.ts)
 * //     └── ...  (other local files related to mod.js)
 * ```
 */
export async function build(options: BuildOptions): Promise<void> {
  try {
    await assemble(options);
  } catch (e) {
    await remove(paths.resolve(options.outDir)).catch(() => {});
    if (e instanceof BuildError) throw e;

    const io = Object.values(Deno.errors).some((kind) => e instanceof kind);
    throw new BuildError(io ? "IO_FAILED" : "UNKNOWN_ERROR", e instanceof Error ? e.message : String(e), e);
  }
}

// =====================================================================================================================
// Internals
// =====================================================================================================================

/**
 * Writes the package, removing the stage and everything else the build needed to get there.
 *
 * @param options The project config and everything around it.
 *
 * @returns Nothing.
 *
 * @throws {BuildError} Every code {@linkcode build} lists, except `IO_FAILED` and `UNKNOWN_ERROR`.
 * @throws {Deno.errors.PermissionDenied} When the file system refuses a read, write or removal.
 * @throws {Deno.errors.NotCapable} When the build runs without one of the permissions it needs.
 */
async function assemble(options: BuildOptions): Promise<void> {
  const ROOT = paths.resolve(options.root ?? Deno.cwd());
  const OUT = paths.resolve(options.outDir);
  const NPM_REPLACEMENTS = new Map(Object.entries(options.npmReplacements ?? {}));
  const DEPS_DIR = options.depsDir ?? "_deps";
  const SOURCE_MAP = options.sourceMap ?? true;
  const MODULES = options.modules ?? "esm";
  const KINDS: ("esm" | "cjs")[] = MODULES === "both" ? ["esm", "cjs"] : [MODULES];
  const PRIMARY = KINDS[0];

  // ===================================================================================================================
  // Module graph
  // ===================================================================================================================

  // --- The entry points to walk from ---------------------------------------------------------------------------------

  const denoJson = options.denoJson;
  const exports = denoJson.exports;
  const entryPoints = typeof exports === "string" ? [[".", exports]] : Object.entries(exports);
  const entryUrls = entryPoints.map(([, path]) => paths.toFileUrl(paths.join(ROOT, path)).href);

  // --- The import map `deno info` resolves against -------------------------------------------------------------------

  const rootUrl = paths.toFileUrl(paths.join(ROOT, "/"));
  // Deno ignores `importMap` when the config carries `imports` of its own.
  const mapFile = denoJson.imports === undefined ? denoJson.importMap : undefined;
  const mapPath = mapFile === undefined
    ? undefined
    : paths.resolve(ROOT, mapFile.startsWith("file:") ? paths.fromFileUrl(mapFile) : mapFile);

  const mapUrl = mapPath === undefined ? rootUrl : paths.toFileUrl(mapPath);
  const map = mapPath === undefined ? denoJson : JSON.parse(await Deno.readTextFile(mapPath));
  const mapImports: Record<string, string> = map.imports ?? {};
  const mapScopes: Record<string, Record<string, string>> = map.scopes ?? {};

  // A module may import the package by its own name, which only the project's own config resolves.
  const selfImports = Object.fromEntries(
    entryPoints.map(([subpath, path]) => [denoJson.name + subpath.slice(1), path]),
  );
  const imports = { ...rebase(selfImports, rootUrl), ...rebase(mapImports, mapUrl) };
  const scopes = mapEntries(mapScopes, ([prefix, entries]) => [absolute(prefix, mapUrl), rebase(entries, mapUrl)]);

  // No scope of the map applies under a directory holding its own config: Deno resolves those modules by it.
  for (const prefix of Object.keys(scopes)) {
    if (!isLocal(prefix)) continue;
    for (const name of ["deno.json", "deno.jsonc"]) {
      if (await fs.exists(paths.join(paths.fromFileUrl(prefix), name))) {
        throw new BuildError(
          "INVALID_CONFIG",
          `an import-map scope names a directory that holds its own ${name}, which Deno reads over the map (${prefix})`,
        );
      }
    }
  }

  // --- The project's own `compilerOptions` ---------------------------------------------------------------------------

  const projectOptions = { ...denoJson.compilerOptions };
  const declarations: string[] = (Array.isArray(projectOptions.types) ? projectOptions.types : [])
    .map((name: string) => name.startsWith(".") ? paths.toFileUrl(paths.resolve(ROOT, name)).href : name);
  projectOptions.types = declarations;

  // --- The npm packages the project's own manifest requires ----------------------------------------------------------

  const manifestPath = paths.join(ROOT, "package.json");
  const hasManifest = await fs.exists(manifestPath);
  const own = hasManifest ? JSON.parse(await Deno.readTextFile(manifestPath)) : {};
  const projectDeps: Record<string, string> = {
    ...own.optionalDependencies,
    ...own.peerDependencies,
    ...own.devDependencies,
    ...own.dependencies,
  };

  // --- The temporary config `deno info` resolves the graph against ---------------------------------------------------

  // For a config outside the project, Deno reads a package name out of `node_modules` under `manual` alone.
  const manual = denoJson.nodeModulesDir === "manual" && hasManifest;
  const bareImports = manual ? {} : mapValues(projectDeps, (range, name) => `npm:${name}@${range}`);
  await using configDir = await tempDir({
    "deno.json": JSON.stringify({
      imports: { ...bareImports, ...imports },
      scopes,
      compilerOptions: projectOptions,
      ...(manual ? { nodeModulesDir: "manual" } : {}),
    }),
  });

  // --- Every module the entry points reach ---------------------------------------------------------------------------

  const moduleOf = new Map<string, GraphModule>();
  const redirects: Record<string, string> = {};
  const walked = new Set<string>();

  const roots = [...entryUrls];
  while (roots.length > 0) {
    const entry = roots.pop()!;
    if (walked.has(entry)) continue;
    walked.add(entry);

    const args = ["info", "--json", "--allow-import", "--config", paths.join(configDir.path, "deno.json"), entry];
    const graph = JSON.parse(await run(Deno.execPath(), args, ROOT)) as Graph;
    for (const module of graph.modules) moduleOf.set(module.specifier, module);
    Object.assign(redirects, graph.redirects);

    for (const module of graph.modules) {
      for await (const target of unlisted(module)) {
        if (!moduleOf.has(target) && (!isLocal(target) || await fs.exists(paths.fromFileUrl(target)))) {
          roots.push(target);
        }
      }
    }
  }
  // `deno info` records a redirect chain hop by hop, not collapsed to its end.
  for (const [from, to] of Object.entries(redirects)) redirects[from] = follow(to, redirects);

  // --- The npm package each import-map alias stands for --------------------------------------------------------------

  const aliases = [
    ...Object.entries(scopes).flatMap(([scope, entries]) => bindings(entries, scope)),
    ...bindings(mapImports, ""),
  ]
    // An import map matches the narrowest scope first, and inside it the longest alias.
    .sort((a, b) => b.scope.length - a.scope.length || b.alias.length - a.alias.length);

  // --- What each module becomes --------------------------------------------------------------------------------------

  const shipped = new Set<string>();
  const unaliased: RegistryPackage[] = [];
  const reached = new Set<Binding>();
  const installed = new Set<string>();
  const typesOf = new Map<string, string>();
  const typesFor = new Map<string, string>();
  const shims = new Map<string, string>();
  // `deno info` lists a declaration named in `compilerOptions.types` as a module no dependency points at.
  const queue = [...entryUrls, ...declarations.filter(isLocal)];
  while (queue.length > 0) {
    const specifier = queue.pop()!;
    const module = moduleOf.get(specifier)!;
    if (module.error) throw new BuildError("DEPENDENCY_FAILED", `${module.error} (${specifier})`);

    if (shipped.has(specifier) || !travels(specifier)) continue;
    shipped.add(specifier);

    for await (const named of unlisted(module)) {
      const target = redirects[named] ?? named;
      if (moduleOf.has(target)) queue.push(target);
    }

    const header = module.typesDependency?.dependency.specifier;
    if (header !== undefined) {
      const declaration = redirects[header] ?? header;
      if (travels(declaration) && declaration !== specifier && !typesOf.has(specifier)) {
        if (!typesOf.has(declaration)) typesOf.set(declaration, specifier);
        typesFor.set(specifier, declaration);
        queue.push(declaration);
      }
    }

    // --- Where each dependency it names leads ------------------------------------------------------------------------

    for (const dependency of module.dependencies ?? []) {
      const target = dependency.code ?? dependency.type;

      if (dependency.code?.error) throw new BuildError("DEPENDENCY_FAILED", `${dependency.code.error} (${specifier})`);

      const binding = aliasOf(dependency.specifier, specifier);
      if (binding?.npm) reached.add(binding);

      const code = dependency.code?.specifier;
      const runs = code === undefined ? undefined : redirects[code] ?? code;
      const beside = runs !== undefined && !binding?.npm && travels(runs);
      const types = dependency.type?.specifier;
      if (types !== undefined && isLocal(types) && !beside) {
        const declaration = redirects[types] ?? types;
        shims.set(rewrite(dependency.specifier, runs ?? dependency.specifier, specifier), declaration);
        queue.push(declaration);
      }

      if (binding?.npm || target?.specifier === undefined) continue;

      const resolved = redirects[target.specifier] ?? target.specifier;

      if (moduleOf.get(resolved)?.kind === "external") {
        if (!resolved.includes("/node_modules/")) {
          throw new BuildError(
            "UNSHIPPABLE_PACKAGE",
            `'deno info' gives it no kind and no source, as it gives none to a source-phase or a text import (${resolved})`,
          );
        }
        installed.add(bareName(resolved.split("/node_modules/").pop()!));
      }

      // `deno info` reports an `npm:` dependency under the version it picked, not the range the source asked for.
      const npm = registry(resolved);
      const asked = registry(dependency.specifier);
      if (npm?.scheme === "npm") unaliased.push(asked?.name === npm.name ? { ...npm, range: asked.range } : npm);

      const typesNpm = registry(types ?? "");
      if (typesNpm?.scheme === "npm") unaliased.push(typesNpm);

      queue.push(resolved);

      if (types !== undefined && dependency.code !== undefined) {
        const declaration = redirects[types] ?? types;

        // `deno info` can name one module in both halves, as its code and as its types.
        if (beside && travels(declaration) && declaration !== resolved && !typesOf.has(resolved)) {
          if (!typesOf.has(declaration)) typesOf.set(declaration, resolved);
          typesFor.set(resolved, declaration);
          queue.push(declaration);
        }
      }
    }
  }

  // --- The directory the shipped modules of the project sit under ----------------------------------------------------

  const srcRoot = paths.common([...shipped].filter(isLocal).map((s) => paths.dirname(paths.fromFileUrl(s))));

  // --- One version range per npm package -----------------------------------------------------------------------------

  const required = [
    ...aliases.filter((binding) => reached.has(binding)).map(({ alias, npm }) => ({ ...npm!, via: `"${alias}"` })),
    ...unaliased.map((npm) => ({ ...npm, via: "a module of the graph" })),
  ];

  const ranges = new Map<string, string>();
  for (const { name, range: wanted, via } of required) {
    const range = ranges.get(name);

    if (range === undefined || unpinned(range)) {
      ranges.set(name, wanted);
    } else if (!unpinned(wanted) && canonical(range) !== canonical(wanted)) {
      const both = intersection(range, wanted);
      if (both === null) {
        throw new BuildError(
          "INVALID_CONFIG",
          `required as both ${range} and ${wanted}, the second via ${via} (${name})`,
        );
      }
      ranges.set(name, both);
    }
  }

  // --- The dependencies the package ships with -----------------------------------------------------------------------

  for (const name of installed) {
    if (ranges.has(name)) continue;

    const range = projectDeps[name];
    if (range === undefined) {
      throw new BuildError(
        "INVALID_CONFIG",
        `answered by node_modules but not a dependency in package.json (${name})`,
      );
    }
    ranges.set(name, range);
  }
  const dependencies = Object.fromEntries(ranges);

  // ===================================================================================================================
  // Staged sources
  // ===================================================================================================================

  // --- The output tree, emptied --------------------------------------------------------------------------------------

  await remove(OUT);
  const stage = paths.join(OUT, "src");
  const trees = KINDS.map((kind) => paths.join(OUT, kind));
  const primaryTree = paths.join(OUT, PRIMARY);
  // `tsc` makes a tree only where it emits, and a package of declarations alone leaves it nothing to emit.
  for (const tree of trees) await Deno.mkdir(tree, { recursive: true });

  // --- One module per path in the package, settled before anything is written ----------------------------------------

  const claims = new Map<string, string>();
  // The CommonJS tree names its own module kind in a `package.json` at the root every module stages under.
  if (KINDS.includes("cjs")) claims.set("package.json", "the CommonJS tree's own package.json");

  for (const module of moduleOf.values()) {
    if (!shipped.has(module.specifier)) continue;
    if (extensionOf(module) === undefined) {
      throw new BuildError(
        "UNSHIPPABLE_PACKAGE",
        `only TypeScript, JavaScript, JSON and WebAssembly modules can ship inside the package (${module.specifier})`,
      );
    }

    const stagedPath = staged(module.specifier);

    // `tsc` reports nothing when a module and a `.d.ts` of the same name both stand as inputs.
    const typed = /\.[cm]?tsx?$/.test(stagedPath) && !isDeclaration(stagedPath);
    const claimed = new Set([stagedPath, emitted(stagedPath), ...(typed ? [declared(stagedPath)] : [])]);
    for (const path of claimed) {
      const other = claims.get(path);
      // `fromFileUrl` drops a query and a fragment, so two specifiers that differ only there name one file.
      if (
        other !== undefined && isLocal(other) && isLocal(module.specifier) &&
        paths.fromFileUrl(other) === paths.fromFileUrl(module.specifier)
      ) {
        continue;
      }

      if (other !== undefined && typesOf.get(other) !== module.specifier && typesOf.get(module.specifier) !== other) {
        throw new BuildError(
          "UNSHIPPABLE_PACKAGE",
          `package path is already claimed by ${other} (${module.specifier})`,
        );
      }
      claims.set(path, module.specifier);
    }
  }

  for (const [path, specifier] of claims) {
    for (let dir = paths.dirname(path); dir !== paths.dirname(dir); dir = paths.dirname(dir)) {
      const other = claims.get(dir);
      if (other !== undefined) {
        throw new BuildError(
          "UNSHIPPABLE_PACKAGE",
          `package path leads through ${other}, which is a module of its own (${specifier})`,
        );
      }
    }
  }

  // --- Every shipped module, staged on its package path --------------------------------------------------------------

  const sourceOf = new Map<string, string>();
  const ambient = new Set<string>();
  const assets = new Map<string, string>();
  let jsxStaged = false;
  let wasmStaged = false;
  for (const module of moduleOf.values()) {
    if (!shipped.has(module.specifier)) continue;
    const stagedPath = staged(module.specifier);
    if (/\.[jt]sx$/.test(stagedPath)) jsxStaged = true;

    // A WebAssembly module carries no source to rewrite, and `tsc` reads it through a declaration written beside it.
    if (module.kind === "wasm") {
      const declaration = declared(stagedPath);
      await write(paths.join(stage, declaration), await wasmTypes(module.specifier));
      sourceOf.set(declaration, module.specifier);
      wasmStaged = true;
      continue;
    }

    // `import.meta.resolve` names a file the package has to hold, which need not be a module `tsc` can read.
    if (!COMPILED.test(stagedPath)) {
      assets.set(stagedPath, module.local!);
      continue;
    }

    // --- The specifiers the source writes ----------------------------------------------------------------------------

    const source = await textOf(module);
    const written = specifiers(source, stagedPath, JAVASCRIPT_MEDIA.test(module.mediaType ?? ""));

    for (const { kind, text } of written) if (kind === "module") ambient.add(text);

    // --- The replacement for every specifier the graph listed --------------------------------------------------------

    const { replacements, directives } = rewritesFor(module, module.specifier);

    // --- The replacement for every specifier the graph did not list --------------------------------------------------

    for (const { text, quoted } of written) {
      if (!quoted || replacements.has(text) || !/^(\.|https?:)/.test(text)) continue;

      const named = new URL(text, module.specifier).href;
      const target = redirects[named] ?? named;
      if (!shipped.has(target)) continue;

      const rewritten = rewrite(text, target, module.specifier);
      if (rewritten !== text) replacements.set(text, rewritten);
    }

    // --- The replacement for every template import -------------------------------------------------------------------

    for (const { text: pattern, parts } of written) {
      if (parts === undefined) continue;
      const wanted = new Set<string>();
      for (const { specifier } of module.dependencies ?? []) {
        const values = wildcards(pattern, specifier);
        if (values === undefined) continue;

        const folded = refold(pattern, values, replacements.get(specifier) ?? specifier);
        if (folded !== null && folded !== pattern) wanted.add(folded);
      }
      if (wanted.size > 1) {
        throw new BuildError(
          "UNSHIPPABLE_PACKAGE",
          `a template import matches modules that no single specifier can name (${module.specifier})`,
        );
      }
      for (const to of wanted) replacements.set(pattern, to);
    }

    // --- The file written into the stage -----------------------------------------------------------------------------

    const text = rewriteSpecifiers(source, written, { replacements, directives });

    await write(
      paths.join(stage, stagedPath),
      paths.basename(stagedPath) === "package.json" ? esmManifest(text) : text,
    );
    sourceOf.set(stagedPath, module.specifier);

    // --- The copy a shared declaration needs beside this module ------------------------------------------------------

    const claimedTypes = typesFor.get(module.specifier);
    if (claimedTypes !== undefined && typesOf.get(claimedTypes) !== module.specifier) {
      const besidePath = declared(stagedPath);
      const declaration = moduleOf.get(claimedTypes)!;
      const beside = await textOf(declaration);
      const rewrites = rewritesFor(declaration, module.specifier);

      await write(paths.join(stage, besidePath), rewriteSpecifiers(beside, specifiers(beside, besidePath), rewrites));
      sourceOf.set(besidePath, claimedTypes);
    }
  }

  // ===================================================================================================================
  // Emit
  // ===================================================================================================================

  // --- The dependencies the emit needs, installed under a draft manifest ---------------------------------------------

  const draft = { type: "module", dependencies, devDependencies: { "@types/node": "^26" } };
  await write(paths.join(OUT, "package.json"), JSON.stringify(draft));
  await run(Deno.execPath(), ["install", "--quiet", "--no-lock"], OUT);

  // --- The vendored sources, compiled apart --------------------------------------------------------------------------

  const [local, vendored] = partition([...shipped], isLocal);
  const vendorStaged = vendored.map(staged).filter((path) => /\.[cm]?[jt]sx?$/.test(path) && !isDeclaration(path));
  // `tsc` writes no declaration at all for a module that breaks `isolatedDeclarations`.
  const vendorReport = vendorStaged.length > 0 ? await emit(vendorStaged, { isolatedDeclarations: false }) : "";
  if (vendorReport) console.warn(`ignored diagnostics in vendored sources:\n${vendorReport}`);

  // --- Each vendored source, replaced by its declaration -------------------------------------------------------------

  for (const path of vendorStaged) {
    const declaration = declared(path);

    // A vendored source left in the stage is compiled again by the pass that forgives nothing.
    await remove(paths.join(stage, path));

    if (sourceOf.has(declaration)) continue;

    if (!await fs.exists(paths.join(primaryTree, declaration))) {
      throw new BuildError(
        "EMIT_FAILED",
        `no declaration was emitted for a vendored module (${sourceOf.get(path)!})\n${vendorReport}`,
      );
    }
    await fs.copy(paths.join(primaryTree, declaration), paths.join(stage, declaration));
  }

  // --- The project's own sources, which nothing forgives -------------------------------------------------------------

  const localReport = await emit(local.map(staged).filter((path) => COMPILED.test(path)));
  if (localReport) throw new BuildError("EMIT_FAILED", localReport);

  // --- The declarations `tsc` emits nothing for ----------------------------------------------------------------------

  for (const path of sourceOf.keys()) {
    if (isDeclaration(path)) {
      const text = await Deno.readTextFile(paths.join(stage, path));
      for (const tree of trees) await write(paths.join(tree, path), text);
    }
  }

  // --- The files a module names without importing them ---------------------------------------------------------------

  for (const [path, from] of assets) {
    for (const tree of trees) {
      const to = paths.join(tree, path);
      await Deno.mkdir(paths.dirname(to), { recursive: true });
      await fs.copy(from, to, { overwrite: true });
    }
  }

  // --- The modules no emit writes, shipped with their imports renamed ------------------------------------------------

  const wasmImports = new Map<string, Pick<Specifier, "kind" | "text">[]>();
  for (const module of moduleOf.values()) {
    if (!shipped.has(module.specifier) || module.kind !== "wasm") continue;

    // Deno and Node both resolve the specifiers a WebAssembly module imports against the module's own URL, rather
    // than against the source that imported the module.
    const { replacements } = rewritesFor(module, module.specifier);
    const held: Pick<Specifier, "kind" | "text">[] = [];
    let bytes = await bytesOf(module);
    try {
      bytes = rewriteImports(bytes, (from) => {
        // A runtime reads the import of a WebAssembly module as a URL, the way it reads the one of a source, and
        // the rewrite names the module by the path the file system holds it under.
        const written = replacements.has(from) ? escapePath(replacements.get(from)!) : from;
        held.push({ kind: "import", text: written });
        return written;
      });
    } catch (e) {
      throw new BuildError(
        "UNSHIPPABLE_PACKAGE",
        `the imports of a WebAssembly module cannot be rewritten (${module.specifier})`,
        e,
      );
    }

    for (const tree of trees) {
      const path = paths.join(tree, staged(module.specifier));
      await Deno.mkdir(paths.dirname(path), { recursive: true });
      await Deno.writeFile(path, bytes);
      wasmImports.set(path, held);
    }
  }

  // --- The rewrites that had to wait for the emit --------------------------------------------------------------------

  for (const path of await emittedFiles()) {
    const code = await Deno.readTextFile(path);
    const written = specifiers(code, path);

    const directives = new Map(
      written
        .filter(({ kind, text }) => kind === "directive" && text.startsWith(".") && text !== declared(text))
        .map(({ text }) => [text, declared(text)]),
    );

    // A runtime reads a relative specifier as a URL, where `%` opens an escape, `#` a fragment and `?` a query.
    // `tsc` reads none of the three, and writes the name it was given.
    const replacements = new Map(
      isDeclaration(path) ? [] : written
        .filter(({ quoted, text }) => quoted && text.startsWith(".") && /[%#?]/.test(text))
        .map(({ text }) => [text, escapePath(text)]),
    );

    if (directives.size + replacements.size > 0) {
      await write(path, rewriteSpecifiers(code, written, { replacements, directives }));
    }
  }

  // ===================================================================================================================
  // Package assembly
  // ===================================================================================================================

  // --- The `exports` map, one subpath per entry point ----------------------------------------------------------------

  const exportsMap: Record<string, ExportTarget | { require: ExportTarget; default: ExportTarget }> = {};
  for (const [subpath, entry] of entryPoints) {
    const path = toPosix(paths.relative(srcRoot, paths.join(ROOT, entry)));

    // A runtime reads an `exports` target as a URL; `types` is read by `tsc`, which reads the name as it is written.
    const target = (kind: "esm" | "cjs"): ExportTarget => ({
      types: `./${kind}/${declared(path)}`,
      ...(isDeclaration(path) ? {} : { default: `./${kind}/${escapePath(emitted(path))}` }),
    });

    // `tsc` reads the module kind of a declaration from the tree it sits in, so each condition answers with its own.
    exportsMap[subpath] = MODULES === "both" ? { require: target("cjs"), default: target("esm") } : target(PRIMARY);
  }

  // --- The real manifest, over the one the emit ran under ------------------------------------------------------------

  const fields = ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"];
  const ships: Record<string, Record<string, string>> = {};
  for (const [name, range] of Object.entries(dependencies)) {
    const field = fields.find((spelled) => own[spelled]?.[name] !== undefined) ?? "dependencies";
    (ships[field] ??= {})[name] = own[field]?.[name] ?? range;
  }

  const rootExport = exportsMap["."];
  // A resolver that reads `main` at all reads it as a path on disk, and escapes it itself.
  const rootFallback = rootExport && "require" in rootExport ? rootExport.require : rootExport;
  const manifest = sortPackageJson({
    name: denoJson.name,
    version: denoJson.version,
    type: "module",
    // Metro before 0.82 ignores `exports`.
    ...(rootFallback && { types: rootFallback.types }),
    ...(rootFallback?.default && { main: unescapePath(rootFallback.default) }),
    exports: exportsMap,
    ...(ships.dependencies && { dependencies: ships.dependencies }),
    ...(ships.peerDependencies && { peerDependencies: ships.peerDependencies }),
    ...(ships.optionalDependencies && { optionalDependencies: ships.optionalDependencies }),
    ...(ships.devDependencies && { devDependencies: ships.devDependencies }),
    ...options.packageJson,
  });
  await write(paths.join(OUT, "package.json"), JSON.stringify(manifest, null, 2));

  // --- The module kind the CommonJS tree is read under ---------------------------------------------------------------

  if (KINDS.includes("cjs")) {
    await write(paths.join(OUT, "cjs", "package.json"), JSON.stringify({ type: "commonjs" }, null, 2));
  }

  // --- The settings the package is typed under -----------------------------------------------------------------------

  const named = declarations.map((name) => isLocal(name) ? `./${PRIMARY}/${toPosix(staged(name))}` : name);
  const config = {
    compilerOptions: {
      ...settings(),
      ...(named.length > 0 ? { types: distinct(named) } : {}),
    },
  };
  await write(paths.join(OUT, "tsconfig.json"), JSON.stringify(config, null, 2));

  // --- The build's leftovers, taken out of the package ---------------------------------------------------------------

  for (const path of [stage, paths.join(OUT, "node_modules")]) await remove(path);

  // ===================================================================================================================
  // Package verification
  // ===================================================================================================================

  const broken: string[] = [];

  // --- Every import an npm consumer could not resolve ----------------------------------------------------------------

  for (const path of [...await emittedFiles(), ...wasmImports.keys()]) {
    const where = paths.relative(OUT, path);
    const written: Pick<Specifier, "kind" | "text">[] = wasmImports.get(path) ??
      specifiers(await Deno.readTextFile(path), path);

    for (const node of written) {
      if (node.kind === "dynamic") continue;

      const typeOnly = isDeclaration(path) || node.kind === "type" || node.kind === "directive";
      const isSource = /\.[cm]?tsx?$/.test(node.text) && !(typeOnly && isDeclaration(node.text));

      if (isSource || /^(jsr|npm|https?|file):/.test(node.text)) {
        broken.push(`${where}: ${node.text}`);
      } else if (node.text.startsWith(".")) {
        const target = paths.join(paths.dirname(path), isDeclaration(path) ? node.text : unescapePath(node.text));
        const found = node.text.includes("*") ||
          await fs.exists(target) || (isDeclaration(path) && await fs.exists(declared(target)));

        // `import.meta.resolve` does not ask the file to exist.
        if (!found && node.kind !== "resolve") broken.push(`${where}: ${node.text} does not exist`);
      } else {
        const name = bareName(node.text);
        const installs = dependencies[name] !== undefined || name === denoJson.name || ambient.has(node.text);
        // A declaration is read under `skipLibCheck`, where a built-in subpath that leads nowhere costs nothing,
        // while a runtime specifier goes to Node, which throws on one.
        const builtin = builtinModules.includes(typeOnly ? name : node.text);

        // `declare module "x"` types a module the package need not install.
        if (node.kind !== "module" && !/^(node|data):/.test(node.text) && !builtin && !installs) {
          broken.push(`${where}: ${node.text} is neither a built-in nor a dependency`);
        }
      }
    }
  }

  // --- Every file the build's own `exports` promises -------------------------------------------------------------------

  // Node reads an `exports` target as a file of the package only when it starts with `./` and steps through no
  // `.`, `..` or `node_modules` segment, spelled plainly or percent-encoded.
  const outside = /(^|\/)(\.|%2e){1,2}(\/|$)|(^|\/)node_modules(\/|$)/i;
  for (const file of strings(exportsMap)) {
    if (!file.startsWith("./") || outside.test(file.slice(2))) {
      broken.push(`exports: ${file} is not a path inside the package`);
      continue;
    }

    // A runtime target is escaped, and a `types` one is read by `tsc`, which reads the name as it is written.
    if (!await fs.exists(paths.join(OUT, isDeclaration(file) ? file : unescapePath(file)))) {
      broken.push(`exports: ${file} does not exist`);
    }
  }
  if (broken.length > 0) throw new BuildError("UNSHIPPABLE_PACKAGE", broken.join("\n"));

  // ===================================================================================================================
  // Helpers
  // ===================================================================================================================

  /**
   * Every specifier a module wrote, against the one an emitted module beside `referrer` needs in its place.
   *
   * @param module The module whose specifiers are read.
   * @param referrer The module the emitted file sits beside, which a relative specifier is written against.
   *
   * @returns The replacements for imports, and the ones for triple-slash directives.
   */
  function rewritesFor(module: GraphModule, referrer: string): Rewrites {
    const replacements = new Map<string, string>();
    const directives = new Map<string, string>();
    for (const dependency of module.dependencies ?? []) {
      const target = dependency.code ?? dependency.type;
      if (!target?.specifier) continue;

      const resolved = redirects[target.specifier] ?? target.specifier;
      const rewritten = rewrite(dependency.specifier, resolved, referrer);
      if (rewritten !== dependency.specifier) replacements.set(dependency.specifier, rewritten);

      // `tsc` resolves a triple-slash directive while compiling, when the module is still a `.ts` in the stage.
      const beforeEmit = rewrite(dependency.specifier, resolved, referrer, true);
      if (beforeEmit !== dependency.specifier) directives.set(dependency.specifier, beforeEmit);
    }
    return { replacements, directives };
  }

  /**
   * What each alias of one import-map section stands for.
   *
   * @param entries The section, keyed by the alias the sources import.
   * @param scope The URL prefix the section applies to, empty for the map's own `imports`.
   *
   * @returns One binding per alias, naming the npm package it leads to wherever it leads to one.
   */
  function bindings(entries: Record<string, string>, scope: string): Binding[] {
    return Object.entries(entries).map(([alias, specifier]) => {
      const target = registry(specifier);
      const name = NPM_REPLACEMENTS.get(alias) ?? (target?.scheme === "npm" ? target.name : null);
      const npm = name == null ? null : { name, range: target?.range ?? "*", subpath: target?.subpath ?? "" };
      return { scope, alias, npm };
    });
  }

  /**
   * True for a module the package holds a file for, as opposed to one the consumer installs from npm.
   *
   * @param specifier The module specifier, after redirects.
   *
   * @returns True when the specifier is a `file:` or `http(s):` URL the graph did not mark external.
   *
   * @example
   * ```ts
   * travels("file:///home/me/lib/mod.ts");  // => true
   * travels("npm:chalk@5.3.0");             // => false
   * travels("node:fs");                     // => false
   * ```
   */
  function travels(specifier: string): boolean {
    return /^(file|https?):/.test(specifier) && moduleOf.get(specifier)?.kind !== "external";
  }

  /**
   * The import-map binding a written specifier resolves through.
   *
   * @param written The specifier as the source wrote it.
   * @param importer The module that wrote it, which decides the scopes in force.
   *
   * @returns The binding it resolves through, or `undefined` when no alias matches.
   */
  function aliasOf(written: string, importer: string): Binding | undefined {
    return aliases.find(({ scope, alias }) =>
      (scope === "" || importer.startsWith(scope)) &&
      (alias.endsWith("/") ? written.startsWith(alias) : written === alias || written.startsWith(`${alias}/`))
    );
  }

  /**
   * A module's path inside the stage tree, relative to its root.
   *
   * @param specifier The module specifier, as the graph reports it.
   *
   * @returns Its path under the source root, or one under {@linkcode BuildOptions.depsDir} for a remote module.
   *
   * @example
   * ```ts
   * staged("file:///home/me/lib/src/mod.ts");  // => "mod.ts", when srcRoot is /home/me/lib/src
   * staged("https://deno.land/x/lib/mod.ts");  // => "_deps/deno.land/x/lib/mod.ts"
   * staged("https://esm.sh/preact@10.24.0");   // => "_deps/esm.sh/preact@10.24.0/mod.js"
   * ```
   */
  function staged(specifier: string): string {
    // `tsc` reads a declaration only from beside the module it belongs to, under the name that module would emit.
    const describes = typesOf.get(specifier);
    if (describes !== undefined) return declared(staged(describes));

    const url = new URL(specifier);
    const extension = extensionOf(moduleOf.get(specifier) ?? { specifier }) ?? "";

    // Two URLs that differ only in query or fragment are two modules, and so two files of the package.
    const mark = (url.search + url.hash).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    const marked = (path: string) =>
      mark === "" ? path : `${path.slice(0, path.length - extension.length)}__${mark}${extension}`;

    if (isLocal(specifier)) return marked(paths.relative(srcRoot, paths.fromFileUrl(url)));

    const path = extension !== "" && url.pathname.endsWith(extension)
      ? url.pathname
      : paths.join(url.pathname, `mod${extension}`);

    return paths.join(DEPS_DIR, url.host.replaceAll(":", "__"), marked(path));
  }

  /**
   * The specifier an emitted module imports in place of the one its source wrote.
   *
   * @param written The specifier as the source wrote it.
   * @param resolved The module it resolves to, after redirects.
   * @param referrer The module doing the importing.
   * @param beforeEmit Name the module as it is staged, rather than as `tsc` will emit it. Default: `false`.
   *
   * @returns The specifier to write in its place, or {@linkcode written} when the target does not ship in the package.
   *
   * @example
   * ```ts
   * // with npmReplacements { "@hono/hono": "hono" }
   * rewrite("@hono/hono/jsx", "https://jsr.io/@hono/hono/4.6.3/jsx.ts", "file:///lib/mod.ts");
   * // => "hono/jsx"
   *
   * rewrite("@std/path", "https://jsr.io/@std/path/1.1.6/mod.ts", "file:///lib/mod.ts");
   * // => "./_deps/jsr.io/@std/path/1.1.6/mod.js"
   * ```
   */
  function rewrite(written: string, resolved: string, referrer: string, beforeEmit = false): string {
    const binding = aliasOf(written, referrer);
    if (binding?.npm) return binding.npm.name + binding.npm.subpath + written.slice(binding.alias.length);

    const npm = registry(resolved);
    if (npm) return npm.name + npm.subpath;

    if (resolved.startsWith("node:")) return resolved;
    if (!shipped.has(resolved)) return written;

    const inPackage = toPosix(paths.relative(paths.dirname(staged(referrer)), staged(resolved)));
    const relativePath = beforeEmit ? inPackage : emitted(inPackage);
    return ts.isExternalModuleNameRelative(relativePath) ? relativePath : `./${relativePath}`;
  }

  /**
   * The options the package is checked under, the defaults of `deno check` included.
   *
   * @returns Every option but the ones the emit alone needs.
   */
  function settings(): Record<string, unknown> {
    // A `deno.` library carries an ES library with it, which `tsc` has to be told about by name.
    const spelled = (projectOptions.lib as string[] | undefined) ?? [];
    const own = spelled.filter((name) => !name.toLowerCase().startsWith("deno."));
    const lib = spelled.length === own.length ? own : ["esnext", ...own];

    // `projectOptions.types` holds a list even when the project named none, which would ship as `"types": []`.
    const { types: _named, ...options } = projectOptions;

    const jsxImportSource = projectOptions.jsxImportSource;
    const jsxSource = typeof jsxImportSource === "string"
      ? rewrite(jsxImportSource, jsxImportSource, rootUrl.href)
      : null;

    return {
      target: "esnext",
      noImplicitOverride: true,
      preserveConstEnums: true,
      skipLibCheck: true,
      ...(jsxStaged ? { jsx: "react" } : {}),
      ...(wasmStaged ? { allowArbitraryExtensions: true } : {}),
      ...options,
      ...(jsxSource ? { jsxImportSource: jsxSource } : {}),
      ...(lib.length > 0 ? { lib } : {}),
      module: "nodenext",
    };
  }

  /**
   * Compiles one program of staged files, naming each diagnostic after the module the file was read from.
   *
   * @param files Staged paths, relative to the stage root.
   * @param overrides Compiler options to write over the project's own.
   *
   * @returns Every diagnostic as one block of text, empty when the program is clean.
   */
  function tsc(files: string[], overrides: Record<string, unknown>): string {
    // --- The options this program runs under -------------------------------------------------------------------------

    const javaScript = files.some((path) => /\.[cm]?jsx?$/.test(path));
    const types = declarations.map((name) => isLocal(name) ? paths.join(stage, staged(name)) : name);
    const compilerOptions = {
      ...settings(),
      // `tsc` refuses `allowJs` beside `isolatedDeclarations`.
      ...(javaScript ? { allowJs: true, isolatedDeclarations: false } : {}),
      types: distinct(["node", ...types]),
      moduleResolution: "nodenext",
      paths: Object.fromEntries([...shims].map(([written, url]) => [written, [paths.join(stage, staged(url))]])),
      declaration: true,
      sourceMap: SOURCE_MAP,
      inlineSources: SOURCE_MAP,
      rootDir: paths.relative(OUT, stage),
      ...overrides,
    };

    // --- One program over those files, emitted -----------------------------------------------------------------------

    const { options, errors } = ts.convertCompilerOptionsFromJson(compilerOptions, OUT);
    const host = ts.createCompilerHost(options);

    host.getCurrentDirectory = () => OUT;

    const program = ts.createProgram(files.map((path) => paths.join(stage, path)), options, host);
    const diagnostics = ts.sortAndDeduplicateDiagnostics(
      [...errors, ...ts.getPreEmitDiagnostics(program), ...program.emit().diagnostics],
    );

    // --- Every diagnostic as one line of text ------------------------------------------------------------------------

    return diagnostics.map((diagnostic) => {
      const category = ts.DiagnosticCategory[diagnostic.category].toLowerCase();
      const head = `${category} TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
      if (!diagnostic.file) return head;

      const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start!);
      const specifier = sourceOf.get(paths.relative(stage, diagnostic.file.fileName));
      const origin = specifier && isLocal(specifier) ? paths.fromFileUrl(specifier) : specifier;
      return `${origin ?? diagnostic.file.fileName}(${line + 1},${character + 1}): ${head}`;
    }).join("\n");
  }

  /**
   * Every module the build left in the trees the package ships.
   *
   * @returns The path of each JavaScript module and each declaration. A JSON module is not among them.
   */
  async function emittedFiles(): Promise<string[]> {
    const found: string[] = [];
    for (const tree of trees) {
      for await (const entry of fs.walk(tree, { includeDirs: false, match: [/\.[cm]?[jt]s$/] })) found.push(entry.path);
    }
    return found;
  }

  /**
   * Compiles staged files into every tree the package ships, each tree with declarations of its own.
   *
   * @param files Staged paths, relative to the stage root.
   * @param overrides Compiler options to write over the project's own.
   *
   * @returns Every diagnostic of every tree as one block of text, empty when they are all clean.
   */
  async function emit(files: string[], overrides: Record<string, unknown> = {}): Promise<string> {
    const reported = new Set<string>();
    for (const kind of KINDS) {
      // `nodenext` reads the module kind of a source from the nearest `package.json`, not from the options.
      if (kind === "cjs") await write(paths.join(stage, "package.json"), JSON.stringify({ type: "commonjs" }));

      const held = new Map<string, string>();
      for (const path of files) {
        const at = paths.join(stage, path);
        const source = await Deno.readTextFile(at);
        const plain = forEmit(source, path, kind === "cjs");
        if (plain !== source) {
          held.set(at, source);
          await write(at, plain);
        }
      }

      const report = tsc(files, {
        outDir: kind,
        // `verbatimModuleSyntax` refuses an ESM source the `cjs` pass emits as CommonJS.
        ...(kind === "cjs" ? { verbatimModuleSyntax: false } : {}),
        ...overrides,
      });
      if (kind === "cjs") await remove(paths.join(stage, "package.json"));
      for (const [at, source] of held) await write(at, source);

      for (const diagnostic of report.split(/\n(?! )/)) if (diagnostic !== "") reported.add(diagnostic);
    }
    return [...reported].join("\n");
  }
}

// =====================================================================================================================
// Internal: types
// =====================================================================================================================

/** A module specifier, and the run of source text it takes up, which `code.slice(start, end)` cuts out. */
interface Specifier {
  /** The specifier itself, without the quotes around it. */
  text: string;
  /** Where the run starts. */
  start: number;
  /** Where the run ends. */
  end: number;
  /** True when the whole run can be written again as one quoted string, which a substitution rules out. */
  quoted: boolean;
  /**
   * The syntax it is written in, which decides what a consumer has to be able to resolve.
   * - `"import"`: A static `import`, an `export … from`, an `import … = require()` or a `require()` call.
   * - `"dynamic"`: An `import()` call.
   * - `"type"`: An `import("…")` type, or a JSDoc `@import` tag.
   * - `"module"`: The name a `declare module "…"` augments.
   * - `"resolve"`: An `import.meta.resolve` call.
   * - `"directive"`: A triple-slash directive.
   */
  kind: "import" | "dynamic" | "type" | "module" | "resolve" | "directive";
  /** The source text of each substitution, for a specifier written as a template or glued together with `+`. */
  parts?: string[];
  /** True when the substitutions were glued together with `+` rather than written inside a template. */
  glued?: boolean;
}

/** What an emitted module writes in place of the specifiers its source wrote. */
interface Rewrites {
  /** Each written import specifier, mapped to the one that takes its place. */
  replacements: Map<string, string>;
  /** The same for a triple-slash directive, which names a file rather than a module. */
  directives: Map<string, string>;
}

/** Where one subpath of `exports` leads inside one module tree of the package. */
interface ExportTarget {
  /** The declaration `tsc` reads, which decides the module kind it types the subpath under. */
  types: string;
  /** The module a runtime loads, absent for an entry point that is a declaration and has nothing to run. */
  default?: string;
}

/** What one import-map alias stands for, and where it holds. */
interface Binding {
  /** The URL prefix the mapping applies to, empty for the map's own `imports`. */
  scope: string;
  /** The alias the sources import. */
  alias: string;
  /** The npm package the alias leads to, or `null` when it leads elsewhere. */
  npm: Omit<RegistryPackage, "scheme"> | null;
}

/** The package a `npm:` or `jsr:` specifier names. */
interface RegistryPackage {
  /** The registry the package comes from. */
  scheme: string;
  /** The package name, its scope included. */
  name: string;
  /** The version range the package is required under. */
  range: string;
  /** The path inside the package, empty when the specifier names none. */
  subpath: string;
}

/**
 * The graph `deno info --json` prints, narrowed to the fields the build reads.
 *
 * @see null
 */
interface Graph {
  /** Every module reachable from the entry point, the entry point included. */
  modules: GraphModule[];
  /** Each specifier that was redirected, mapped to the URL of the next hop. */
  redirects: Record<string, string>;
}

/**
 * One module of that graph.
 *
 * @see null
 */
interface GraphModule {
  /** The module's URL, which is its identity in the graph. */
  specifier: string;
  /** The kind the graph resolved it as, absent for a module that could not be loaded. */
  kind?: "esm" | "asserted" | "wasm" | "npm" | "node" | "external";
  /** The file it was read from: the source for a local module, Deno's cached copy for a remote one. */
  local?: string;
  /** The language Deno resolved it as, from the URL or the response headers. */
  mediaType?: string;
  /** Why it could not be loaded, if it could not. */
  error?: string;
  /** The declaration the module claims for itself through an `X-TypeScript-Types` header. */
  typesDependency?: { dependency: { specifier?: string } };
  /** What it imports, one entry per specifier the source wrote. */
  dependencies?: {
    /** The specifier as the source wrote it. */
    specifier: string;
    /** The module it runs against, or why the graph could not resolve one. */
    code?: { specifier?: string; error?: string };
    /** The module it is typed against, as `@deno-types` or a types header names it. */
    type?: { specifier?: string; error?: string };
  }[];
}

// =====================================================================================================================
// Internal: module kinds
// =====================================================================================================================

/** The `deno info` media types of a module whose JSDoc carries its types, rather than its syntax. */
const JAVASCRIPT_MEDIA = /^(JavaScript|Mjs|Cjs|JSX)$/;

/** The package paths `tsc` reads as input, as opposed to the ones that travel as the files they are. */
const COMPILED = /\.([cm]?[jt]sx?|json)$/;

/** The file extension each `deno info` media type implies. */
const MEDIA_EXTENSIONS: Record<string, string> = {
  TypeScript: ".ts",
  Mts: ".mts",
  Cts: ".cts",
  TSX: ".tsx",
  JavaScript: ".js",
  Mjs: ".mjs",
  Cjs: ".cjs",
  JSX: ".jsx",
  Json: ".json",
  Dts: ".d.ts",
  Dmts: ".d.mts",
  Dcts: ".d.cts",
};

/**
 * The extension a module ships under.
 *
 * @param module The module to read, as the graph reports it.
 *
 * @returns The extension, or `undefined` for a kind that cannot ship.
 *
 * @example
 * ```ts
 * extensionOf({ specifier: "file:///lib/mod.ts", mediaType: "TypeScript" });  // => ".ts"
 * extensionOf({ specifier: "file:///lib/add.wasm", kind: "wasm" });           // => ".wasm"
 * extensionOf({ specifier: "file:///lib/note.txt" });                         // => undefined
 * ```
 */
function extensionOf(module: GraphModule): string | undefined {
  // The graph names no media type for a WebAssembly module, only its kind.
  return module.kind === "wasm" ? ".wasm" : MEDIA_EXTENSIONS[module.mediaType ?? ""];
}

// =====================================================================================================================
// Internal: module contents
// =====================================================================================================================

/**
 * The declaration `tsc` reads a WebAssembly module through.
 *
 * @param specifier The module's URL.
 *
 * @returns The text of the declaration, one line per export and one line exporting them all,
 *          and `export {};` for a module that exports nothing.
 *
 * @throws {BuildError} `UNSHIPPABLE_PACKAGE` when no declaration can bind an export's kind or spell its type.
 */
async function wasmTypes(specifier: string): Promise<string> {
  const { symbols } = (await doc([specifier], {
    // An export's type is its own, so nothing the module imports is resolved or read.
    resolve: () => "data:application/typescript,",
  }))[specifier];

  /** The type as a declaration spells it, over the four shapes a WebAssembly export is documented in. */
  function spelled(type: TsTypeDef | undefined): string {
    if (type?.kind === "keyword") return type.value;
    if (type?.kind === "typeRef") return type.value.typeName;
    if (type?.kind === "union") return type.value.map(spelled).join(" | ");
    if (type?.kind === "tuple") return `[${type.value.map(spelled).join(", ")}]`;
    throw new BuildError(
      "UNSHIPPABLE_PACKAGE",
      `an export carries a type of kind ${type?.kind}, which no declaration can spell (${specifier})`,
    );
  }

  const declared: string[] = [];
  const exported: string[] = [];
  for (const { name, declarations } of symbols) {
    const declaration = declarations[0];
    if (declaration.kind !== "function" && declaration.kind !== "variable") {
      throw new BuildError(
        "UNSHIPPABLE_PACKAGE",
        `${JSON.stringify(name)} is documented as ${declaration.kind}, which no declaration can bind (${specifier})`,
      );
    }

    const alias = `_${declared.length}`;
    if (declaration.kind === "function") {
      // A WebAssembly module names none of its parameters, so position is the whole of what a caller has to go by.
      const params = declaration.def.params.map((param, at) => `arg${at}: ${spelled(param.tsType)}`);
      declared.push(`declare function ${alias}(${params.join(", ")}): ${spelled(declaration.def.returnType)};`);
    } else {
      declared.push(`declare const ${alias}: ${spelled(declaration.def.tsType)};`);
    }
    exported.push(`${alias} as ${JSON.stringify(name)}`);
  }

  // A file that declares nothing is no module to `tsc`, and importing it is an error.
  if (declared.length === 0) return "export {};\n";
  return `${declared.join("\n")}\nexport { ${exported.join(", ")} };\n`;
}

/**
 * The source of a module, as the build reads it.
 *
 * @param module The module to read, as the graph reports it.
 *
 * @returns Its source, without the trailer Deno appends to a file it caches.
 *
 * @throws {Deno.errors.NotCapable} When the build runs without one of the permissions it needs.
 */
async function textOf(module: GraphModule): Promise<string> {
  const read = await Deno.readTextFile(module.local!);
  return isLocal(module.specifier) ? read : read.replace(/\n\/\/ denoCacheMetadata=\{[^\n]*\}\s*$/, "");
}

/**
 * The bytes of a module, as the build ships them.
 *
 * @param module The module to read, as the graph reports it.
 *
 * @returns Its content, without the trailer Deno appends to a file it caches.
 *
 * @throws {Deno.errors.NotCapable} When the build runs without one of the permissions it needs.
 */
async function bytesOf(module: GraphModule): Promise<Uint8Array> {
  const read = await Deno.readFile(module.local!);
  if (isLocal(module.specifier)) return read;

  const at = lastIndexOfNeedle(read, new TextEncoder().encode("\n// denoCacheMetadata="));
  return at < 0 ? read : read.subarray(0, at);
}

/**
 * Every module a source names that the graph lists no dependency of its own for.
 *
 * @param module The module to read, as the graph reports it.
 *
 * @returns Each specifier it names, resolved against the module.
 *
 * @throws {Deno.errors.NotCapable} When the build runs without one of the permissions it needs.
 */
async function* unlisted(module: GraphModule): AsyncGenerator<string> {
  if (module.local === undefined) return;
  if (!/^(TypeScript|Mts|Cts|TSX|JavaScript|Mjs|Cjs|JSX)$/.test(module.mediaType ?? "")) return;

  const listed = new Set((module.dependencies ?? []).map((dependency) => dependency.specifier));
  const javaScript = JAVASCRIPT_MEDIA.test(module.mediaType ?? "");
  for (const { text, quoted } of specifiers(await textOf(module), module.specifier, javaScript)) {
    if (quoted && !listed.has(text) && /^(\.|https?:)/.test(text)) yield new URL(text, module.specifier).href;
  }
}

// =====================================================================================================================
// Internal: WebAssembly binaries
// =====================================================================================================================

/** The preamble every WebAssembly module starts with: the magic word, and version 1. */
const WASM_HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

/**
 * Rewrites the module name of every import a WebAssembly module holds.
 *
 * @param wasm The module to read.
 * @param rename What each import's module name becomes.
 *
 * @returns The module, byte for byte as it came in but for the names `rename` changed
 *          and, when one of those changed length, the two lengths counting it.
 *
 * @throws {Error} When the module is not one this can read, or the rewrite cannot be written.
 *
 * @example
 * ```ts
 * const bytes = await Deno.readFile("clock.wasm");
 *
 * rewriteImports(bytes, (from) => from.replace(/\.ts$/, ".js"));  // => the same module, importing "./time.js"
 * ```
 */
function rewriteImports(wasm: Uint8Array, rename: (from: string) => string): Uint8Array {
  if (wasm.length < WASM_HEADER.length || WASM_HEADER.some((byte, index) => wasm[index] !== byte)) {
    throw new Error("not a WebAssembly module: the header is not 00 61 73 6d 01 00 00 00");
  }

  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const binary = new TextEncoder();

  // How far the read has come, and how far it may go.
  let at = WASM_HEADER.length;
  let limit = wasm.length;

  // The rewritten import section, of which the first `written` bytes are the ones it holds.
  let rebuilt = new Uint8Array(0);
  let written = 0;

  /** The byte under the cursor, with the cursor moved past it. */
  function take(what: string): number {
    if (at >= limit) throw new Error(`${what}: runs past the end of the input`);
    return wasm[at++];
  }

  /** An unsigned LEB128, of the five bytes and 32 bits a `u32` takes. */
  function u32(what: string): number {
    let value = 0, shift = 0, byte = 0;
    do {
      byte = take(what);
      if (shift === 28 && byte > 0x0f) throw new Error(`${what}: LEB128 is over five bytes or over 2^32`);
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return value;
  }

  /** Moves the cursor past a LEB128, which is copied over rather than read, so that only its width matters. */
  function past(what: string): void {
    let byte = 0, read = 0;
    do {
      byte = take(what);
      if (++read > 10) throw new Error(`${what}: LEB128 is over the ten bytes a u64 takes`);
    } while (byte & 0x80);
  }

  /** Moves the cursor past the limits of a table or a memory. */
  function limits(what: string): void {
    const flags = take(`${what} limits flags`);
    if (flags > 0x07) throw new Error(`${what} limits flags 0x${flags.toString(16)} are unknown`);

    // A 64-bit table or memory, which flag 4 asks for, writes each of its bounds as the `u64` it is.
    past(`${what} minimum`);
    if (flags & 1) past(`${what} maximum`);
  }

  /** The name the bytes from `from` up to `till` spell. */
  function decode(what: string, from: number, till: number): string {
    try {
      return text.decode(wasm.subarray(from, till));
    } catch (cause) {
      throw new Error(`${what} does not decode as UTF-8`, { cause });
    }
  }

  /** A number, as the LEB128 a length is written in, in as few bytes as it takes. */
  function leb(value: number): Uint8Array {
    const out: number[] = [];
    do {
      const byte = value & 0x7f;
      value >>>= 7;
      out.push(value === 0 ? byte : byte | 0x80);
    } while (value !== 0);
    return new Uint8Array(out);
  }

  /** Appends bytes to the import section being rebuilt. */
  function emit(bytes: Uint8Array): void {
    const need = written + bytes.length;
    if (need > 0xffffffff) throw new Error("the rewritten import section is past the 4 GiB its u32 size field holds");
    if (need > rebuilt.length) {
      const grown = new Uint8Array(Math.max(Math.min(rebuilt.length * 2, 0xffffffff), need));
      grown.set(rebuilt.subarray(0, written));
      rebuilt = grown;
    }
    rebuilt.set(bytes, written);
    written = need;
  }

  // Where the import section stands in the input: the one range of it that is not copied over.
  let importsAt = -1;
  let importsBody = -1;
  let importsEnd = -1;

  while (at < wasm.length) {
    const start = at;
    const kind = wasm[at++];
    const size = u32(`section 0x${kind.toString(16)} size`);
    const body = at;
    if (size > wasm.length - body) {
      throw new Error(`section 0x${kind.toString(16)} of ${size} bytes runs past the end of the file`);
    }
    const end = body + size;

    if (size === 0) {
      throw new Error(`empty section 0x${kind.toString(16)}: a section body carries a name, a count or an index`);
    }
    // Every section but the imports is copied over without being read, so nothing about its body has to hold.
    if (kind !== 0x02) {
      at = end;
      continue;
    }
    if (importsAt >= 0) throw new Error("a second import section, of which only the last would be rewritten");

    importsAt = start;
    importsBody = body;
    importsEnd = end;
    rebuilt = new Uint8Array(size);
    limit = end;

    const count = u32("import count");
    emit(wasm.subarray(body, at));

    for (let i = 0; i < count; i++) {
      const from = at;
      const length = u32(`import[${i}] module name length`);
      if (length > limit - at) {
        throw new Error(`import[${i}] module name of ${length} bytes runs past the end of the import section`);
      }

      const nameAt = at;
      const till = at + length;
      at = till;

      const to = rename(decode(`import[${i}] module name`, nameAt, till));
      if (!to.isWellFormed()) throw new Error(`import[${i}] module name became a string with no UTF-8 encoding`);
      const renamed = binary.encode(to);
      emit(renamed.length === length ? wasm.subarray(from, nameAt) : leb(renamed.length));
      emit(renamed);

      const kept = at;
      const field = u32(`import[${i}] field name length`);
      if (field > limit - at) {
        throw new Error(`import[${i}] field name of ${field} bytes runs past the end of the import section`);
      }
      at += field;

      const descriptor = take(`import[${i}] descriptor`);
      if (descriptor === 0x00) {
        u32(`import[${i}] type index`);
      } else if (descriptor === 0x01) {
        take(`import[${i}] table element type`);
        limits(`import[${i}] table`);
      } else if (descriptor === 0x02) {
        limits(`import[${i}] memory`);
      } else if (descriptor === 0x03) {
        const type = take(`import[${i}] global type`);
        if (type === 0x63 || type === 0x64) past(`import[${i}] global type index`);
        take(`import[${i}] global mutability`);
      } else if (descriptor === 0x04) {
        take(`import[${i}] tag attribute`);
        u32(`import[${i}] tag type index`);
      } else {
        throw new Error(`unknown import descriptor 0x${descriptor.toString(16)}`);
      }
      emit(wasm.subarray(kept, at));
    }

    if (at !== end) throw new Error(`import section read ${at - body} of ${size} bytes`);
    limit = wasm.length;
  }

  if (importsAt < 0) return wasm.slice();

  const frame = written === importsEnd - importsBody
    ? wasm.subarray(importsAt, importsBody)
    : new Uint8Array([0x02, ...leb(written)]);

  const out = new Uint8Array(importsAt + frame.length + written + (wasm.length - importsEnd));
  out.set(wasm.subarray(0, importsAt));
  out.set(frame, importsAt);
  out.set(rebuilt.subarray(0, written), importsAt + frame.length);
  out.set(wasm.subarray(importsEnd), importsAt + frame.length + written);
  return out;
}

// =====================================================================================================================
// Internal: files and commands
// =====================================================================================================================

/**
 * Writes a file, creating the directories leading to it.
 *
 * @param path The file to write.
 * @param text The content to write.
 *
 * @returns Nothing.
 *
 * @throws {Deno.errors.IsADirectory} When `path` is a directory.
 * @throws {Deno.errors.NotADirectory} When a directory on the way to `path` is a file.
 * @throws {Deno.errors.FilesystemLoop} When `path` leads through a cycle of symbolic links.
 * @throws {Deno.errors.PermissionDenied | Deno.errors.NotCapable} When the file system or the runtime refuses it.
 */
async function write(path: string, text: string): Promise<void> {
  await Deno.mkdir(paths.dirname(path), { recursive: true });
  await Deno.writeTextFile(path, text);
}

/**
 * Removes a path and everything under it, ignoring one that is not there.
 *
 * @param path The file or directory to remove.
 *
 * @returns Nothing.
 *
 * @throws {Deno.errors.NotADirectory} When a directory on the way to `path` is a file.
 * @throws {Deno.errors.FilesystemLoop} When `path` leads through a cycle of symbolic links.
 * @throws {Deno.errors.PermissionDenied | Deno.errors.NotCapable} When the file system or the runtime refuses it.
 */
async function remove(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}

/**
 * A temporary directory holding `files`, removed once its binding leaves scope.
 *
 * @param files The content of each file to write, keyed by the name it takes inside the directory.
 *
 * @returns The directory's path, alongside the disposer that removes it.
 *
 * @throws {Deno.errors.NotFound} When the directory temporary files go in does not exist.
 * @throws {Deno.errors.NotADirectory} When that directory is a file.
 * @throws {Deno.errors.PermissionDenied | Deno.errors.NotCapable} When the file system or the runtime refuses it.
 */
async function tempDir(files: Record<string, string>): Promise<{ path: string } & AsyncDisposable> {
  const path = await Deno.makeTempDir();
  for (const [name, text] of Object.entries(files)) await Deno.writeTextFile(paths.join(path, name), text);
  return { path, [Symbol.asyncDispose]: () => remove(path) };
}

/**
 * Runs `cmd` with `args` in `cwd`, waiting for it to exit.
 *
 * @param cmd The executable to run.
 * @param args The arguments to run it with.
 * @param cwd The directory to run it in.
 *
 * @returns Everything the command wrote to standard output.
 *
 * @throws {BuildError} `DEPENDENCY_FAILED` when the command exits non-zero, carrying both of its streams.
 * @throws {Deno.errors.NotFound} When `cwd` does not exist.
 * @throws {Deno.errors.NotCapable} When the build runs without one of the permissions it needs.
 */
async function run(cmd: string, args: string[], cwd: string): Promise<string> {
  const { code, stdout, stderr } = await new Deno.Command(cmd, { args, cwd, env: { NO_COLOR: "1" } }).output();
  const out = new TextDecoder().decode(stdout);
  if (code !== 0) {
    throw new BuildError(
      "DEPENDENCY_FAILED",
      `'${cmd} ${args.join(" ")}' exited ${code}\n${out}\n${new TextDecoder().decode(stderr)}`,
    );
  }
  return out;
}

// =====================================================================================================================
// Internal: import maps
// =====================================================================================================================

/**
 * An import-map path made absolute against the project.
 *
 * @param path An alias target or a scope prefix, as the project's own config spells it.
 * @param base The project's directory URL, which a relative path is written against.
 *
 * @returns An absolute URL for a relative path, and the path itself for a bare specifier or a full URL.
 *
 * @example
 * ```ts
 * const base = new URL("file:///home/me/lib/");
 * absolute("./src/mod.ts", base);  // => "file:///home/me/lib/src/mod.ts"
 * absolute("npm:chalk@^5", base);  // => "npm:chalk@^5"
 * ```
 */
function absolute(path: string, base: URL): string {
  return /^\.{0,2}\//.test(path) ? new URL(path, base).href : path;
}

/**
 * An import map with every target made absolute.
 *
 * @param map The import map, keyed by the alias the sources import.
 * @param base The project's directory URL.
 *
 * @returns The same map, with each target resolved against `base`.
 *
 * @example
 * ```ts
 * const base = new URL("file:///home/me/lib/");
 * rebase({ "@/": "./src/" }, base);           // => { "@/": "file:///home/me/lib/src/" }
 * rebase({ "chalk": "npm:chalk@^5" }, base);  // => { "chalk": "npm:chalk@^5" }
 * ```
 */
function rebase(map: Record<string, string>, base: URL): Record<string, string> {
  return mapValues(map, (target) => absolute(target, base));
}

// =====================================================================================================================
// Internal: specifiers
// =====================================================================================================================

/**
 * The registry package a specifier names.
 *
 * @param specifier The specifier to read, in any form a source or an import map writes.
 *
 * @returns Its parts, or `undefined` when it names no registry package.
 *
 * @example
 * ```ts
 * registry("npm:chalk@^5/utils");  // => { scheme: "npm", name: "chalk", range: "^5", subpath: "/utils" }
 * registry("jsr:@std/path");       // => { scheme: "jsr", name: "@std/path", range: "*", subpath: "" }
 * registry("./mod.ts");            // => undefined
 * ```
 */
function registry(specifier: string): RegistryPackage | undefined {
  const [, scheme, name, range, subpath] =
    specifier.match(/^(npm|jsr):\/?(@[^/]+\/[^@/]+|[^@/]+)(?:@([^/]+))?(\/.*)?$/) ?? [];
  if (scheme === undefined) return undefined;
  return { scheme, name, range: range ?? "*", subpath: subpath ?? "" };
}

/**
 * The end of a redirect chain.
 *
 * @param from The specifier to follow.
 * @param redirects Every hop, as the graph reports them.
 *
 * @returns The specifier nothing redirects any further, and `from` itself for a chain that closes on it.
 *
 * @example
 * ```ts
 * const hops = { "http://h/a.ts": "http://h/b.ts", "http://h/b.ts": "http://h/c.ts" };
 * follow("http://h/a.ts", hops);  // => "http://h/c.ts"
 * follow("http://h/c.ts", hops);  // => "http://h/c.ts"
 * ```
 */
function follow(from: string, redirects: Record<string, string>): string {
  const seen = new Set<string>();
  let current = from;
  while (redirects[current] !== undefined && !seen.has(current)) {
    seen.add(current);
    current = redirects[current];
  }
  return current;
}

/**
 * The package a bare specifier names.
 *
 * @param specifier The specifier as a module writes it.
 *
 * @returns The package name, its scope included.
 *
 * @example
 * ```ts
 * bareName("chalk/utils");      // => "chalk"
 * bareName("@std/path/posix");  // => "@std/path"
 * ```
 */
function bareName(specifier: string): string {
  return specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
}

/**
 * True for a module of the project itself, as opposed to one fetched over the network.
 *
 * @param specifier The module specifier to test.
 *
 * @returns True when the specifier is a `file:` URL.
 *
 * @example
 * ```ts
 * isLocal("file:///home/me/lib/mod.ts");             // => true
 * isLocal("https://jsr.io/@std/path/1.1.6/mod.ts");  // => false
 * isLocal("npm:chalk@^5");                           // => false
 * ```
 */
function isLocal(specifier: string): boolean {
  return specifier.startsWith("file://");
}

// =====================================================================================================================
// Internal: package paths
// =====================================================================================================================

/**
 * A path in the forward-slash form module specifiers and `package.json` fields are written in.
 *
 * @param path The path to convert.
 *
 * @returns The same path with every platform separator replaced by `/`.
 *
 * @example
 * ```ts
 * // on posix
 * toPosix("_deps/jsr.io/@std/path/mod.js");      // => "_deps/jsr.io/@std/path/mod.js"
 *
 * // on Windows
 * toPosix("_deps\\jsr.io\\@std\\path\\mod.js");  // => "_deps/jsr.io/@std/path/mod.js"
 * ```
 */
function toPosix(path: string): string {
  return path.replaceAll(paths.SEPARATOR, "/");
}

/**
 * A relative path spelled so that a URL parser reads it as the file name it is.
 *
 * @param path The path as the file system holds it.
 *
 * @returns The same path with every character a URL would take for punctuation escaped.
 *
 * @example
 * ```ts
 * escapePath("./sub/a#b.js");   // => "./sub/a%23b.js"
 * escapePath("./sub/c?d.js");   // => "./sub/c%3Fd.js"
 * escapePath("./sub/100%.js");  // => "./sub/100%25.js"
 * ```
 */
function escapePath(path: string): string {
  return path.replace(/[%#?]/g, encodeURIComponent);
}

/**
 * A relative path read back from the form {@linkcode escapePath} writes.
 *
 * @param path The path as a specifier spells it.
 *
 * @returns The same path with each escape it introduces turned back into its character.
 *
 * @example
 * ```ts
 * unescapePath("./sub/a%23b.js");  // => "./sub/a#b.js"
 * unescapePath("./sub/a.js");      // => "./sub/a.js"
 * ```
 */
function unescapePath(path: string): string {
  return path.replace(/%(?:25|23|3F)/gi, decodeURIComponent);
}

/**
 * True for a declaration file, which has no runtime twin and so is never renamed to `.js`.
 *
 * @param path The path to test.
 *
 * @returns True when the path ends in `.d.ts`, `.d.mts` or `.d.cts`, or in `.d.` and any text before a final `.ts`.
 *
 * @example
 * ```ts
 * isDeclaration("mod.d.ts");      // => true
 * isDeclaration("mod.d.mts");     // => true
 * isDeclaration("mod.d.api.ts");  // => true
 * isDeclaration("mod.ts");        // => false
 * ```
 */
function isDeclaration(path: string): boolean {
  return /\.d\.([cm]?ts|[^\\/]*\.ts)$/.test(path);
}

/**
 * The emitted path of a staged module.
 *
 * @param path The staged path.
 *
 * @returns The path `tsc` renames the module to, and the path itself for a declaration, which it emits nothing for.
 *
 * @example
 * ```ts
 * emitted("mod.ts");    // => "mod.js"
 * emitted("mod.mts");   // => "mod.mjs"
 * emitted("comp.tsx");  // => "comp.js"
 * emitted("mod.d.ts");  // => "mod.d.ts"
 * ```
 */
function emitted(path: string): string {
  return isDeclaration(path) ? path : path.replace(/\.([cm]?)[jt]sx?$/, ".$1js");
}

/**
 * The path of the declaration `tsc` emits beside a staged module.
 *
 * @param path The staged path.
 *
 * @returns The path of the declaration, or the path itself for a declaration file or a JSON module.
 *
 * @example
 * ```ts
 * declared("mod.ts");     // => "mod.d.ts"
 * declared("mod.cts");    // => "mod.d.cts"
 * declared("comp.tsx");   // => "comp.d.ts"
 * declared("mod.d.ts");   // => "mod.d.ts"
 * declared("add.wasm");   // => "add.d.wasm.ts"
 * declared("data.json");  // => "data.json"
 * ```
 */
function declared(path: string): string {
  if (isDeclaration(path)) return path;
  const named = path.replace(/\.([cm]?)[jt]sx?$/, ".d.$1ts");
  return named === path && !COMPILED.test(path) ? path.replace(/\.([^.\\/]+)$/, ".d.$1.ts") : named;
}

// =====================================================================================================================
// Internal: version ranges
// =====================================================================================================================

/**
 * A version range rewritten as comparators over complete versions.
 *
 * @param range The range as the import map spells it.
 *
 * @returns A form that two spellings of one constraint share, or the range itself when it does not parse.
 *
 * @example
 * ```ts
 * canonical("^6.0.3");          // => ">=6.0.3 <7.0.0"
 * canonical(">=6.0.3 <7.0.0");  // => ">=6.0.3 <7.0.0"
 * canonical("1.x");             // => ">=1.0.0 <2.0.0"
 * canonical("not-a-range");     // => "not-a-range"
 * ```
 */
function canonical(range: string): string {
  const parsed = tryParseRange(range);
  return parsed ? formatRange(parsed) : range;
}

/**
 * The versions two ranges both admit, as a range of its own.
 *
 * @param a One range, as an import map or a specifier spells it.
 * @param b The other one.
 *
 * @returns The range every version satisfying both falls in, or `null` when none does, a range either side cannot parse included.
 *
 * @example
 * ```ts
 * intersection("^1.1.0", "^1.1.1");  // => ">=1.1.0 <2.0.0 >=1.1.1 <2.0.0"
 * intersection("^6 || ^7", "^7");    // => ">=7.0.0 <8.0.0 >=7.0.0 <8.0.0"
 * intersection("^1", "^2");          // => null
 * intersection("latest", "^1");      // => null
 * ```
 */
function intersection(a: string, b: string): string | null {
  const left = tryParseRange(a);
  const right = tryParseRange(b);
  if (left === undefined || right === undefined) return null;

  // A range is a union of comparator sets, and a version answers both only where a set of each side overlap.
  const both = left.flatMap((one) =>
    right.filter((two) => rangeIntersects([one], [two])).map((two) => [...one, ...two])
  );
  return both.length === 0 ? null : formatRange(both);
}

/**
 * True for a version range that pins nothing at all.
 *
 * @param range The range as an import map or a specifier spells it.
 *
 * @returns True for a wildcard spelling, `*` and `x` and the empty string among them. A range as wide as `>=0.0.0` is not one.
 *
 * @example
 * ```ts
 * unpinned("*");         // => true
 * unpinned("x");         // => true
 * unpinned(">=0.0.0");   // => false
 * unpinned("latest");    // => false
 * unpinned("^10.6");     // => false
 * ```
 */
function unpinned(range: string): boolean {
  return canonical(range) === "*";
}

// =====================================================================================================================
// Internal: source text
// =====================================================================================================================

/**
 * Every module specifier in one source file, each with the text it occupies.
 *
 * @param code The source text to parse.
 * @param file The file name the parser reports positions against.
 * @param javaScript Read the JSDoc `@import` tag as well, which names a module only where JSDoc carries the types.
 *                   Default: `false`.
 *
 * @returns Each specifier the file names, imports first and triple-slash directives after them.
 */
function specifiers(code: string, file: string, javaScript = false): Specifier[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);

  // A source that binds `require` at its top level answers its own calls, unless it took the name from `createRequire`.
  const bound = source.statements.some((statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === "require" ||
    ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some((declaration) =>
        ts.isIdentifier(declaration.name) && declaration.name.text === "require" &&
        !(declaration.initializer !== undefined && ts.isCallExpression(declaration.initializer) &&
          ts.isIdentifier(declaration.initializer.expression) &&
          declaration.initializer.expression.text === "createRequire")
      )
  );

  const found: Specifier[] = [];
  (function visit(node: ts.Node): void {
    let literal: ts.Node | undefined;
    let kind: Specifier["kind"] = "import";
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      literal = node.moduleSpecifier;
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      literal = node.argument.literal;
      kind = "type";
    } else if (javaScript && ts.isJSDocImportTag(node)) {
      literal = node.moduleSpecifier;
      kind = "type";
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      literal = node.arguments[0];
      kind = "dynamic";
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      literal = node.moduleReference.expression;
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name) && !node.name.text.includes("*")) {
      // `declare module "x"` names the module it augments, while a wildcard pattern names no module at all.
      literal = node.name;
      kind = "module";
    } else if (
      ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "resolve" && ts.isMetaProperty(node.expression.expression)
    ) {
      literal = node.arguments[0];
      kind = "resolve";
    } else if (
      !bound && ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === "require" && node.arguments.length === 1
    ) {
      literal = node.arguments[0];
    }

    if (literal && ts.isStringLiteralLike(literal)) {
      found.push({
        text: literal.text,
        start: literal.getStart(),
        end: literal.getEnd(),
        quoted: true,
        kind,
      });
    } else if (literal && ts.isTemplateExpression(literal)) {
      const spans = literal.templateSpans;
      found.push({
        text: [literal.head.text, ...spans.map((span) => span.literal.text)].join("*"),
        start: literal.getStart(),
        end: literal.getEnd(),
        quoted: false,
        kind,
        parts: spans.map((span) => code.slice(span.expression.getStart(source), span.expression.getEnd())),
      });
    } else if (literal && ts.isBinaryExpression(literal)) {
      const chain = pieces(literal, source);
      if (chain) {
        found.push({
          ...chain,
          start: literal.getStart(),
          end: literal.getEnd(),
          quoted: chain.parts.length === 0,
          kind,
          glued: true,
        });
      }
    }

    // A JSDoc comment hangs off the syntax tree rather than sitting in it.
    for (const doc of (node as { jsDoc?: ts.Node[] }).jsDoc ?? []) visit(doc);

    ts.forEachChild(node, visit);
  })(source);

  // A triple-slash directive sits beside the syntax tree, not inside it.
  for (const { fileName, pos, end } of [...source.referencedFiles, ...source.typeReferenceDirectives]) {
    found.push({
      text: fileName,
      start: pos,
      end,
      quoted: false,
      kind: "directive",
    });
  }
  return found;
}

/**
 * A source written the way an emit can carry it:
 * - an import that binds nothing is written as the bare one it is worth, which `tsc` keeps
 * - the `with { … }` of every import and export is cut when the emit is CommonJS, which refuses it
 *
 * @param code The source text to edit.
 * @param file The file name the parser reports positions against.
 * @param commonJs Whether the emit is CommonJS.
 *
 * @returns The same source, with those edits made.
 *
 * @example
 * ```ts
 * forEmit('import {} from "./side.js";\n', "mod.ts", false);
 * // => 'import "./side.js";\n'
 *
 * forEmit('import data from "./d.json" with { type: "json" };\n', "mod.ts", true);
 * // => 'import data from "./d.json";\n'
 * ```
 */
function forEmit(code: string, file: string, commonJs: boolean): string {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const cuts: { start: number; end: number }[] = [];

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;

    // `tsc` refuses an import attribute on a statement it turns into `require`.
    if (commonJs && statement.attributes) {
      cuts.push({ start: statement.attributes.getFullStart(), end: statement.attributes.getEnd() });
    }
    if (!ts.isImportDeclaration(statement)) continue;

    // `tsc` drops an import that binds nothing and keeps a bare one, though both mean the same to a runtime.
    const clause = statement.importClause;
    const empty = clause !== undefined && clause.phaseModifier !== ts.SyntaxKind.TypeKeyword &&
      clause.name === undefined &&
      clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings) &&
      clause.namedBindings.elements.length === 0;
    if (empty) cuts.push({ start: clause.getStart(), end: statement.moduleSpecifier.getStart() });
  }

  let out = code;
  for (const { start, end } of cuts.sort((a, b) => b.start - a.start)) out = out.slice(0, start) + out.slice(end);
  return out;
}

/**
 * A specifier glued together with `+`, read as the pattern its literal parts spell out.
 *
 * @param expression The expression an import was given.
 * @param source The file the expression was parsed from.
 *
 * @returns The specifier with a `*` where each substitution belongs, and the source text of each, or `undefined` when
 *          the expression spells out no literal text of its own.
 */
function pieces(expression: ts.Expression, source: ts.SourceFile): { text: string; parts: string[] } | undefined {
  const flat: ts.Expression[] = [];
  (function walk(node: ts.Expression): void {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      walk(node.left);
      walk(node.right);
    } else {
      flat.push(node);
    }
  })(expression);

  if (!flat.some(ts.isStringLiteralLike)) return undefined;

  const parts: string[] = [];
  const text = flat.map((piece) => {
    if (ts.isStringLiteralLike(piece)) return piece.text;
    parts.push(piece.getText(source));
    return "*";
  }).join("");

  return { text, parts };
}

/**
 * Replaces module specifiers at the positions the parser reports, leaving identical strings used as data alone.
 *
 * @param code The source text to edit.
 * @param written Every specifier the text holds, as {@linkcode specifiers} reports them.
 * @param rewrites The specifier to write in place of each one the source wrote.
 *
 * @returns The source text with every listed specifier rewritten.
 */
function rewriteSpecifiers(code: string, written: Specifier[], rewrites: Rewrites): string {
  const edits = written
    .flatMap((specifier) => {
      const to = (specifier.kind === "directive" ? rewrites.directives : rewrites.replacements).get(specifier.text);
      return to === undefined ? [] : [{ ...specifier, to }];
    })
    .sort((a, b) => b.start - a.start);

  let out = code;
  for (const { start, end, quoted, parts, glued, to } of edits) {
    const around = glued ? reglue : retemplate;
    const replacement = parts === undefined ? (quoted ? JSON.stringify(to) : to) : around(to, parts);
    out = out.slice(0, start) + replacement + out.slice(end);
  }
  return out;
}

/**
 * A template specifier written out again, around the substitutions it had.
 *
 * @param pattern The specifier with a `*` where each substitution belongs.
 * @param parts The source text of each substitution, in the order they appear.
 *
 * @returns The template literal to write in place of the old one.
 *
 * @example
 * ```ts
 * retemplate("./plugins/*.js", ["which"]);  // => "`./plugins/${which}.js`"
 * ```
 */
function retemplate(pattern: string, parts: string[]): string {
  const statics = pattern.split("*");
  const body = statics.map((text, index) => (index < parts.length ? `${text}\${${parts[index]}}` : text));
  return `\`${body.join("")}\``;
}

/**
 * A glued specifier written out again, around the substitutions it had.
 *
 * @param pattern The specifier with a `*` where each substitution belongs.
 * @param parts The source text of each substitution, in the order they appear.
 *
 * @returns The `+` chain to write in place of the old one.
 *
 * @example
 * ```ts
 * reglue("./plugins/*.js", ["which"]);  // => '"./plugins/" + which + ".js"'
 * ```
 */
function reglue(pattern: string, parts: string[]): string {
  const statics = pattern.split("*");
  const chain = statics.flatMap((text, index) => [
    ...(text === "" ? [] : [JSON.stringify(text)]),
    ...(index < parts.length ? [parts[index]] : []),
  ]);
  return chain.join(" + ");
}

/**
 * The pattern an emitted module writes in place of the one its source wrote.
 *
 * @param pattern The specifier with a `*` where each substitution belongs, as the source wrote it.
 * @param values The text each `*` stood for in the specifier that matched.
 * @param rewritten That same specifier, rewritten for the emitted module.
 *
 * @returns The rewritten specifier with each substitution back in its place, or `null` when it no longer fits.
 *
 * @example
 * ```ts
 * refold("./mods/*.ts", ["mods"], "./mods/mods.js");              // => "./mods/*.js"
 * refold("./mods/*.ts", ["alpha"], "./mods/alpha.js");            // => "./mods/*.js"
 * refold("./loaders/load-*.ts", ["ad"], "./loaders/load-ad.js");  // => "./loaders/load-*.js"
 * ```
 */
function refold(pattern: string, values: string[], rewritten: string): string | null {
  const written = pattern.split("/");
  const parts = rewritten.split("/");

  const starred = written.flatMap((segment, index) => segment.includes("*") ? [written.length - 1 - index] : []);
  if (starred.length !== values.length) return null;

  for (const [order, fromEnd] of starred.entries()) {
    const at = parts.length - 1 - fromEnd;
    const segment = parts[at];
    if (segment === undefined) return null;

    // The value can read as a substring of the text the pattern spells out itself, so it is placed against the side
    // the rewrite left standing: the head it kept, or the tail when the head lost the scheme it spelled out.
    const [head, tail] = written[written.length - 1 - fromEnd].split("*");
    const value = values[order];
    const front = segment.startsWith(head + value);
    if (!front && !segment.endsWith(value + tail)) return null;

    const found = front ? head.length : segment.length - value.length - tail.length;
    parts[at] = `${segment.slice(0, found)}*${segment.slice(found + value.length)}`;
  }
  return parts.join("/");
}

/**
 * The text each `*` of a pattern stands for in one specifier.
 *
 * @param pattern The specifier with a `*` where each substitution belongs.
 * @param written The specifier to read against it.
 *
 * @returns One string per `*`, or `undefined` when the specifier does not fit the pattern.
 *
 * @example
 * ```ts
 * wildcards("./plugins/*.ts", "./plugins/alpha.ts");  // => ["alpha"]
 * wildcards("./plugins/*.ts", "./other/alpha.ts");    // => undefined
 * ```
 */
function wildcards(pattern: string, written: string): string[] | undefined {
  const statics = pattern.split("*").map((text) => RegExp.escape(text));
  return written.match(new RegExp(`^${statics.join("(.*)")}$`))?.slice(1);
}

// =====================================================================================================================
// Internal: manifest fields
// =====================================================================================================================

/**
 * A `package.json` that names the module kind of the tree it ships in.
 *
 * @param text The manifest as the source holds it.
 *
 * @returns The same manifest, with `"type": "module"` when it named no kind of its own, and unchanged when it holds
 *          anything a manifest cannot be.
 *
 * @throws {SyntaxError} When the manifest does not hold valid JSON.
 *
 * @example
 * ```ts
 * esmManifest('{"name":"x"}');                    // => '{"name":"x","type":"module"}'
 * esmManifest('{"name":"x","type":"commonjs"}');  // => '{"name":"x","type":"commonjs"}'
 * esmManifest('["alpha","beta"]');                // => '["alpha","beta"]'
 * ```
 */
function esmManifest(text: string): string {
  const manifest = JSON.parse(text);
  const named = typeof manifest === "object" && manifest !== null && !Array.isArray(manifest);
  return named && manifest.type === undefined ? JSON.stringify({ ...manifest, type: "module" }) : text;
}

/**
 * Every string a `package.json` field holds, however deep the field nests them.
 *
 * @param field The field value, as the manifest holds it.
 *
 * @returns Each string inside it, in the order they appear.
 *
 * @example
 * ```ts
 * strings({ ".": { types: "./esm/mod.d.ts", default: "./esm/mod.js" } });
 * // => ["./esm/mod.d.ts", "./esm/mod.js"]
 *
 * strings("./esm/mod.js");
 * // => ["./esm/mod.js"]
 * ```
 */
function strings(field: unknown): string[] {
  if (typeof field === "string") return [field];
  return typeof field === "object" && field !== null ? Object.values(field).flatMap(strings) : [];
}
