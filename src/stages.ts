/**
 * The four effectful stage drivers of the build pipeline: vendor, transpile, rewrite, and package.
 *
 * Each stage reads the {@linkcode Analysis} and drives file-system primitives or `deno transpile`, while decisions stay in the pure core.
 *
 * @module
 */

import { basename, dirname, join, relative } from "@std/path";
import type { Analysis, SpecifierIndex } from "./analyze.ts";
import { BuildError } from "./errors.ts";
import * as fs from "./fs.ts";
import type { RawGraph } from "./graph.ts";
import { planPackageJson } from "./pkg.ts";
import {
  restoreSourceMapSource,
  rewriteSpecifiers,
  setSourceMapSource,
  sourceMappingComment,
  updateGeneratedSourceMap,
} from "./rewrite.ts";
import { isRelative, jsToDts, relSpecifier, toPosix, tsToJs } from "./spec.ts";

/** Artifact extensions emitted for each transpiled TypeScript source. */
const EMITTED_EXTENSIONS = [".js", ".d.ts", ".js.map"];

// =============================================================================
// Stage 1: vendor
// =============================================================================

/**
 * Inlines remote dependencies: JavaScript and declarations are copied, while TypeScript is rewritten and transpiled.
 *
 * @throws {BuildError} `DEPENDENCY_FAILED` when a vendored source cannot be read from the Deno cache.
 * @throws {BuildError} `EMIT_FAILED` when vendored TypeScript cannot be transpiled.
 */
export async function vendorStage(analysis: Analysis, graph: RawGraph): Promise<void> {
  const { plan, specifiers, vendoredCode, vendoredCopies } = analysis;
  const decoder = new TextDecoder();

  // Every vendored edge initially points at staged source; the output pass changes only the known `.ts` suffix,
  // while declarations resolve the scratch tree without network access.
  const rewriteVendored = (source: string, url: string, rel: string) =>
    rewriteSpecifiers(source, rel, (spec) => {
      const target = specifiers.resolve(url, spec);
      if (target === null) return spec;
      if (target.kind === "npm") return target.bare;
      return relSpecifier(rel, target.kind === "vendored" ? target.src : target.emit) +
        (target.kind === "local" ? target.suffix : "");
    });

  // The shipped copy stays clean; only the scratch copy receives @ts-nocheck for a consumer using checkJs.
  for (const [url, rel] of vendoredCopies) {
    const rewritten = rewriteVendored(decoder.decode(await graph.readSource(url)), url, rel).code;
    await fs.writeText(join(plan.codeDir, rel), rewritten);
    // A hashbang must stay at byte zero; the scratch-only directive follows it.
    const hashbang = rewritten.match(/^#![^\r\n\u2028\u2029]*(?:\r\n|[\n\r\u2028\u2029]|$)/)?.[0] ?? "";
    const separator = hashbang !== "" && !/[\r\n\u2028\u2029]$/.test(hashbang) ? "\n" : "";
    await fs.writeText(
      join(plan.tmpDir, rel),
      `${hashbang}${separator}// @ts-nocheck\n${rewritten.slice(hashbang.length)}`,
    );
  }

  const vendorFiles: string[] = [];
  const sourceRewrites = new Map<
    string,
    { original: string; rewritten: string; edits: ReturnType<typeof rewriteSpecifiers>["edits"] }
  >();
  for (const [url, { src }] of vendoredCode) {
    const original = decoder.decode(await graph.readSource(url));
    const rewritten = rewriteVendored(original, url, src);
    await fs.writeText(join(plan.tmpDir, src), rewritten.code);
    sourceRewrites.set(url, { original, rewritten: rewritten.code, edits: rewritten.edits });
    vendorFiles.push(src);
  }

  if (vendorFiles.length > 0) {
    const importMap = join(plan.tmpDir, "vendor-importmap.json");
    await fs.writeText(importMap, JSON.stringify(specifiers.vendorImportMap()));
    await fs.transpile({
      importMap,
      files: vendorFiles,
      outDir: plan.codeDir,
      cwd: plan.tmpDir,
      // tmpDir sits inside the consumer's tree,
      // so disable ancestor discovery to isolate third-party code from the consumer's compilerOptions.
      config: "none",
    });

    for (const [url, { emit }] of vendoredCode) {
      const source = sourceRewrites.get(url)!;
      const mapPath = join(plan.codeDir, `${emit}.map`);
      const map = restoreSourceMapSource(
        await fs.readText(mapPath),
        source.rewritten,
        source.original,
        source.edits,
        url,
        mapPath,
      );
      await fs.writeText(mapPath, map);
    }

    // The local declaration pass reads these sources for their types.
    // @ts-nocheck prevents consumer compilerOptions from re-checking code that Deno treats as a remote module.
    for (const relTs of vendorFiles) {
      const path = join(plan.tmpDir, relTs);
      await fs.writeText(path, `// @ts-nocheck\n${await fs.readText(path)}`);
    }
  }
}

// =============================================================================
// Stage 2: transpile
// =============================================================================

/**
 * Type-checks and transpiles local `.ts` sources, retains generated declaration sidecars for copied JavaScript/MJS,
 * and copies other supported sources verbatim.
 *
 * @throws {BuildError} `EMIT_FAILED` when the `deno transpile` subprocess exits non-zero.
 */
export async function transpileStage(analysis: Analysis): Promise<void> {
  const { plan, specifiers, localFiles, localCopies, srcRoot, vendoredCopies } = analysis;

  const importMap = join(plan.tmpDir, "importmap.json");
  await fs.writeText(importMap, JSON.stringify(specifiers.declarationImportMap()));
  const out = join(plan.tmpDir, "out");
  await fs.transpile({
    importMap,
    files: localFiles.map((file) => toPosix(relative(plan.repoRoot, file))),
    outDir: out,
    cwd: plan.repoRoot,
    // The project's own compilerOptions apply to the author's sources, exactly as deno check would.
    config: "inherit",
  });

  for (const file of localFiles) {
    const from = join(out, relative(plan.repoRoot, file)).replace(/\.ts$/, "");
    const to = join(plan.codeDir, relative(srcRoot, file)).replace(/\.ts$/, "");
    for (const extension of EMITTED_EXTENSIONS) await fs.moveEmitted(from + extension, to + extension);
    const mapPath = `${to}.js.map`;
    const map = setSourceMapSource(
      await fs.readText(mapPath),
      toPosix(relative(dirname(mapPath), file)),
      mapPath,
    );
    await fs.writeText(mapPath, map);
  }

  // Non-`.ts` local sources go in verbatim; the rewrite stage still adjusts their import specifiers.
  for (const file of localCopies) {
    const rel = relative(srcRoot, file);
    await fs.copyFile(file, join(plan.codeDir, rel));
  }

  for (const file of localCopies) {
    const rel = relative(srcRoot, file);
    const declaration = jsToDts(rel);
    if (declaration === null) continue;
    const destination = join(plan.codeDir, declaration);
    if (await fs.exists(destination)) continue;
    const source = join(out, relative(plan.repoRoot, file));
    const sidecar = jsToDts(source)!;
    // HACK:
    // Deno emits a query-only JavaScript/MJS declaration with its source extension.
    const emitted = await fs.exists(sidecar) ? sidecar : source;
    await fs.moveEmitted(emitted, destination);
    if (emitted === source) await fs.stripGeneratedAmdDirective(destination);
  }

  for (const rel of vendoredCopies.values()) {
    const declaration = jsToDts(rel);
    if (declaration === null) continue;
    const destination = join(plan.codeDir, declaration);
    if (await fs.exists(destination)) continue;
    const staged = join(plan.tmpDir, rel);
    await fs.moveEmitted(jsToDts(join(out, relative(plan.repoRoot, staged)))!, destination);
  }
}

// =============================================================================
// Stage 3: rewrite
// =============================================================================

/**
 * Rewrites every emitted static specifier to its Node form and updates separate source maps.
 *
 * @throws {BuildError} `EMIT_FAILED` when an emitted module or source map cannot be rewritten.
 */
export async function rewriteStage(analysis: Analysis): Promise<void> {
  const { plan, specifiers, localCopies, srcRoot, vendoredCode, vendoredCopies, sourceByOutput } = analysis;

  // vendorStage already finalized these files' non-relative specifiers.
  // Re-resolving them could let a same-named import-map alias capture the output; only the deferred `.ts` → `.js` flip remains.
  const vendorEmitted = new Set<string>();
  for (const rel of vendoredCopies.values()) {
    vendorEmitted.add(rel);
    const declaration = jsToDts(rel);
    if (declaration !== null) vendorEmitted.add(declaration);
  }
  for (const { emit } of vendoredCode.values()) {
    vendorEmitted.add(emit);
    vendorEmitted.add(emit.replace(/\.js$/, ".d.ts"));
  }
  const copiedModules = new Set([
    ...vendoredCopies.values(),
    ...localCopies.map((file) => toPosix(relative(srcRoot, file))),
  ]);

  for await (const path of fs.walkFiles(plan.codeDir, [".js", ".mjs", ".ts", ".mts", ".cts"])) {
    const fromRel = toPosix(relative(plan.codeDir, path));
    const isDts = /\.d\.[cm]?ts$/.test(path);

    const source = await fs.readText(path);
    const referrer = sourceByOutput.get(fromRel);
    const rewrite = vendorEmitted.has(fromRel)
      ? (specifier: string) => isRelative(specifier) ? relativeToNode(specifier) : specifier
      : (specifier: string) =>
        referrer === undefined ? specifier : rewriteForNode(specifier, referrer, fromRel, specifiers, isDts);
    const rewritten = rewriteSpecifiers(
      source,
      path,
      (specifier) => {
        const target = rewrite(specifier);
        if (isDts && !copiedModules.has(fromRel) && target.startsWith("file:")) {
          throw new BuildError(
            "EMIT_FAILED",
            "emitted declaration contains an absolute file specifier; add an explicit type annotation",
            { subject: target },
          );
        }
        return target;
      },
      !isDts && copiedModules.has(fromRel),
    );

    let code = rewritten.code;
    if (!isDts) {
      const mapPath = `${path}.map`;
      if (await fs.exists(mapPath)) {
        const map = updateGeneratedSourceMap(
          await fs.readText(mapPath),
          source,
          code,
          rewritten.edits,
          mapPath,
        );
        await fs.writeText(mapPath, map);
        code += sourceMappingComment(basename(mapPath));
      }
    }
    await fs.writeText(path, code);
  }
}

/** A relative specifier's Node form: `.ts` → `.js`; a `.d.ts` is copied verbatim (no `.js` twin), so it stays. */
function relativeToNode(spec: string): string {
  const suffixAt = spec.search(/[?#]/);
  const path = suffixAt === -1 ? spec : spec.slice(0, suffixAt);
  const suffix = suffixAt === -1 ? "" : spec.slice(suffixAt);
  return (path.endsWith(".d.ts") ? path : tsToJs(path)) + suffix;
}

/** Resolves one emitted specifier through its original graph edge. */
function rewriteForNode(
  spec: string,
  referrer: string,
  fromRel: string,
  specifiers: SpecifierIndex,
  isDts: boolean,
): string {
  const target = specifiers.resolve(referrer, spec);
  if (target === null) return spec; // `node:` builtins and already-bare externals
  if (target.kind === "npm") return target.bare;
  // TypeScript NodeNext cannot resolve URL suffixes in declaration imports.
  const suffix = target.kind === "local" && !isDts ? target.suffix : "";
  return relSpecifier(fromRel, target.emit) + suffix;
}

// =============================================================================
// Stage 4: package
// =============================================================================

/** Writes the generated `package.json` and copies the author's auxiliary files into the package root. */
export async function packageStage(analysis: Analysis): Promise<void> {
  const { plan } = analysis;
  const pkg = planPackageJson(analysis);
  await fs.writeText(join(plan.outDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  for (const file of plan.copyFiles) {
    await fs.copyPath(join(plan.repoRoot, file), join(plan.outDir, file));
  }
}
