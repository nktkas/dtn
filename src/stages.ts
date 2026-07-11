/**
 * The four effectful stage drivers of the build pipeline: vendor, transpile, rewrite, and package.
 *
 * Each reads the {@linkcode Analysis} and drives the file-system primitives and `deno transpile`; the decisions
 * live in the pure core.
 *
 * @module
 */

import { basename, join, relative } from "@std/path";
import type { Analysis, SpecifierIndex } from "./analyze.ts";
import * as fs from "./fs.ts";
import type { RawGraph } from "./graph.ts";
import type { Plan } from "./intake.ts";
import { planPackageJson } from "./pkg.ts";
import { restoreJsonAttributes, rewriteSpecifiers, sourceMappingComment } from "./rewrite.ts";
import { isRelative, relSpecifier, toPosix, tsToJs } from "./spec.ts";

/** The artifact extensions `deno transpile --declaration` emits per source, by source-map mode. */
function emittedExts(sourceMap: Plan["sourceMap"]): string[] {
  return sourceMap === "separate" ? [".js", ".d.ts", ".js.map"] : [".js", ".d.ts"];
}

// ── Stage 1: vendor ──────────────────────────────────────────────────────────

/**
 * Inlines vendored dependencies: byte assets copied as-is, code rewritten and transpiled, under the code root.
 *
 * @throws {BuildError} `MODULE_LOAD_FAILED` when a vendored source cannot be read from the Deno cache.
 * @throws {BuildError} `TRANSPILE_FAILED` when the `deno transpile` subprocess exits non-zero on the vendored sources.
 */
export async function vendorStage(analysis: Analysis, graph: RawGraph): Promise<void> {
  const { plan, specifiers, vendoredCode, vendoredCopies, vendoredAssets } = analysis;
  const decoder = new TextDecoder();

  // Rewrites a vendored module's specifiers to their package form: a sibling vendored dep by a relative path to its
  // SOURCE (the later pass flips `.ts` → `.js` after the transpile; a copy is its own source), npm deps by bare name.
  const rewriteVendored = (source: string, file: string, rel: string): string =>
    rewriteSpecifiers(source, file, (spec) => {
      if (isRelative(spec)) return spec;
      const target = specifiers.resolve(spec);
      if (target === null) return spec;
      if (target.kind === "npm") return target.bare;
      return relSpecifier(rel, target.kind === "vendored" ? target.src : target.rel);
    });

  // Byte assets go in first — into both the package (runtime) and the scratch tree. A declaration pass resolves a
  // vendored asset through an import map that points into `tmpDir`, so the asset must sit there too, or code that
  // imports it loses its type (degraded to `any`). Staged before the transpile so vendored code is checked against it.
  for (const [url, rel] of vendoredAssets) {
    const bytes = await graph.readSource(url);
    await fs.writeBytes(join(plan.codeDir, rel), bytes);
    await fs.writeBytes(join(plan.tmpDir, rel), bytes);
  }

  // Remote JavaScript: inlined verbatim (already JS — nothing to transpile), only its specifiers rewritten. Written to
  // the package and the scratch tree alike, so the declaration passes resolve it there exactly as they do an asset.
  for (const [url, rel] of vendoredCopies) {
    const rewritten = rewriteVendored(decoder.decode(await graph.readSource(url)), rel, rel);
    await fs.writeText(join(plan.codeDir, rel), rewritten);
    // @ts-nocheck for the local declaration pass, which reads the copy for types only (e.g. under checkJs).
    await fs.writeText(join(plan.tmpDir, rel), `// @ts-nocheck\n${rewritten}`);
  }

  const vendorFiles: string[] = [];
  for (const [url, { src }] of vendoredCode) {
    const rewritten = rewriteVendored(decoder.decode(await graph.readSource(url)), src, src);
    await fs.writeText(join(plan.tmpDir, src), rewritten);
    vendorFiles.push(src);
  }

  if (vendorFiles.length > 0) {
    const importMap = join(plan.tmpDir, "vendor-importmap.json");
    await fs.writeText(importMap, JSON.stringify({ imports: specifiers.vendorImportMap() }));
    await fs.transpile({
      importMap,
      files: vendorFiles,
      outDir: plan.codeDir,
      cwd: plan.tmpDir,
      sourceMap: plan.sourceMap,
      // tmpDir sits inside the user's tree: ancestor discovery would type-check third-party code under the CONSUMER's compilerOptions.
      config: "none",
    });

    // The local declaration pass reads these sources for their types; @ts-nocheck keeps the user's compilerOptions
    // from re-checking third-party code — Deno itself reports no diagnostics inside remote modules.
    for (const relTs of vendorFiles) {
      const path = join(plan.tmpDir, relTs);
      await fs.writeText(path, `// @ts-nocheck\n${await fs.readText(path)}`);
    }
  }
}

// ── Stage 2: transpile ───────────────────────────────────────────────────────

/**
 * Type-checks and transpiles local `.ts` sources, mirroring the emitted `.js`/`.js.map`/`.d.ts` under the code root;
 * non-`.ts` sources are copied verbatim.
 *
 * @throws {BuildError} `TRANSPILE_FAILED` when the `deno transpile` subprocess exits non-zero (e.g. a type error).
 */
export async function transpileStage(analysis: Analysis): Promise<void> {
  const { plan, specifiers, localFiles, localCopies, srcRoot } = analysis;

  // A types-only project has no `.ts` to transpile; `deno transpile` with zero files fails, so skip the pass.
  if (localFiles.length > 0) {
    const importMap = join(plan.tmpDir, "importmap.json");
    await fs.writeText(importMap, JSON.stringify({ imports: specifiers.declarationImportMap() }));
    const out = join(plan.tmpDir, "out");
    await fs.transpile({
      importMap,
      files: localFiles.map((f) => toPosix(relative(plan.repoRoot, f))),
      outDir: out,
      cwd: plan.repoRoot,
      sourceMap: plan.sourceMap,
      // The project's own compilerOptions apply to the author's sources, exactly as deno check would.
      config: "inherit",
    });

    // Mirror each source's emitted artifacts under the code root (the rewrite stage fixes them).
    for (const file of localFiles) {
      const from = join(out, relative(plan.repoRoot, file)).replace(/\.ts$/, "");
      const to = join(plan.codeDir, relative(srcRoot, file)).replace(/\.ts$/, "");
      for (const ext of emittedExts(plan.sourceMap)) await fs.moveEmitted(from + ext, to + ext);
    }
  }

  // Non-`.ts` local sources go in verbatim; the rewrite stage still adjusts their import specifiers.
  for (const file of localCopies) {
    await fs.copyFile(file, join(plan.codeDir, relative(srcRoot, file)));
  }
}

// ── Stage 3: rewrite ─────────────────────────────────────────────────────────

/**
 * Rewrites every emitted specifier to its Node form and applies the declaration and source-map fixups.
 *
 * @throws {BuildError} `REWRITE_PARSE_FAILED` when an emitted module cannot be parsed.
 */
export async function rewriteStage(analysis: Analysis): Promise<void> {
  const { plan, specifiers, vendoredCode, vendoredCopies } = analysis;

  // vendorStage already finalized these files' non-relative specifiers; re-resolving them would let a same-named
  // import-map alias capture the finished output. Only the deferred relative `.ts` → `.js` flip still applies.
  const vendorEmitted = new Set<string>(vendoredCopies.values());
  for (const { emit } of vendoredCode.values()) {
    vendorEmitted.add(emit);
    vendorEmitted.add(emit.replace(/\.js$/, ".d.ts"));
  }

  for await (const path of fs.walkFiles(plan.codeDir, [".js", ".mjs", ".cjs", ".ts"])) {
    const fromRel = toPosix(relative(plan.codeDir, path));
    const isDts = path.endsWith(".d.ts");

    let code = await fs.readText(path);
    code = rewriteSpecifiers(
      code,
      path,
      vendorEmitted.has(fromRel)
        ? (spec) => isRelative(spec) ? relativeToNode(spec) : spec
        : (spec) => rewriteForNode(spec, fromRel, specifiers),
    );
    if (isDts) code = restoreJsonAttributes(code, path);

    // `deno transpile` omits the `sourceMappingURL` comment for a separate map; add it.
    if (!isDts && plan.sourceMap === "separate") {
      const mapPath = `${path}.map`;
      if (await fs.exists(mapPath)) code += sourceMappingComment(basename(mapPath));
    }
    await fs.writeText(path, code);
  }
}

/** A relative specifier's Node form: `.ts` → `.js`; a `.d.ts` is copied verbatim (no `.js` twin), so it stays. */
function relativeToNode(spec: string): string {
  return spec.endsWith(".d.ts") ? spec : tsToJs(spec);
}

/** One specifier → its Node form: relative `.ts`→`.js`, vendored → relative path, external → npm name. */
function rewriteForNode(spec: string, fromRel: string, specifiers: SpecifierIndex): string {
  if (isRelative(spec)) return relativeToNode(spec);
  const target = specifiers.resolve(spec);
  if (target === null) return spec; // `node:` builtins and already-bare externals
  if (target.kind === "npm") return target.bare;
  // A vendored dep and a local-file alias both resolve to a package file addressed by a relative path.
  return relSpecifier(fromRel, target.kind === "vendored" ? target.emit : target.rel);
}

// ── Stage 4: package ─────────────────────────────────────────────────────────

/** Writes the generated `package.json` and copies the author's auxiliary files into the package root. */
export async function packageStage(analysis: Analysis): Promise<void> {
  const { plan } = analysis;
  const pkg = planPackageJson(analysis);
  await fs.writeText(join(plan.outDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  for (const file of plan.copyFiles) {
    await fs.copyPath(join(plan.repoRoot, file), join(plan.outDir, file));
  }
}
