/**
 * The four effectful stage drivers of the build pipeline: vendor, transpile, rewrite, and package.
 *
 * Each stage reads the {@linkcode Analysis} and drives file-system primitives or `deno transpile`, while decisions stay in the pure core.
 *
 * @module
 */

import { basename, join, relative } from "@std/path";
import type { Analysis, SpecifierIndex } from "./analyze.ts";
import * as fs from "./fs.ts";
import type { RawGraph } from "./graph.ts";
import { planPackageJson } from "./pkg.ts";
import {
  restoreSourceMapSource,
  rewriteSpecifiers,
  sourceMappingComment,
  updateGeneratedSourceMap,
} from "./rewrite.ts";
import { isRelative, relSpecifier, toPosix, tsToJs } from "./spec.ts";

/** Artifact extensions emitted for each transpiled TypeScript source. */
const EMITTED_EXTENSIONS = [".js", ".d.ts", ".js.map"];

// =============================================================================
// Stage 1: vendor
// =============================================================================

/**
 * Inlines JSR dependencies: JavaScript and declarations are copied, while TypeScript is rewritten and transpiled.
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
    await fs.writeText(join(plan.tmpDir, rel), `// @ts-nocheck\n${rewritten}`);
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
    await fs.writeText(importMap, JSON.stringify({ imports: specifiers.vendorImportMap() }));
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
 * Type-checks and transpiles local `.ts` sources, mirrors their `.js`/`.js.map`/`.d.ts` artifacts,
 * and copies other supported sources verbatim.
 *
 * @throws {BuildError} `EMIT_FAILED` when the `deno transpile` subprocess exits non-zero.
 */
export async function transpileStage(analysis: Analysis): Promise<void> {
  const { plan, specifiers, localFiles, localCopies, srcRoot } = analysis;

  const importMap = join(plan.tmpDir, "importmap.json");
  await fs.writeText(importMap, JSON.stringify({ imports: specifiers.declarationImportMap() }));
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
  }

  // Non-`.ts` local sources go in verbatim; the rewrite stage still adjusts their import specifiers.
  for (const file of localCopies) {
    await fs.copyFile(file, join(plan.codeDir, relative(srcRoot, file)));
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
  const vendorEmitted = new Set<string>(vendoredCopies.values());
  for (const { emit } of vendoredCode.values()) {
    vendorEmitted.add(emit);
    vendorEmitted.add(emit.replace(/\.js$/, ".d.ts"));
  }
  const copiedModules = new Set([
    ...vendoredCopies.values(),
    ...localCopies.map((file) => toPosix(relative(srcRoot, file))),
  ]);

  for await (const path of fs.walkFiles(plan.codeDir, [".js", ".mjs", ".ts"])) {
    const fromRel = toPosix(relative(plan.codeDir, path));
    const isDts = path.endsWith(".d.ts");

    const source = await fs.readText(path);
    const referrer = sourceByOutput.get(fromRel);
    const rewritten = rewriteSpecifiers(
      source,
      path,
      vendorEmitted.has(fromRel)
        ? (spec) => isRelative(spec) ? relativeToNode(spec) : spec
        : (spec) => referrer === undefined ? spec : rewriteForNode(spec, referrer, fromRel, specifiers),
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
function rewriteForNode(spec: string, referrer: string, fromRel: string, specifiers: SpecifierIndex): string {
  const target = specifiers.resolve(referrer, spec);
  if (target === null) return spec; // `node:` builtins and already-bare externals
  if (target.kind === "npm") return target.bare;
  return relSpecifier(fromRel, target.emit) + (target.kind === "local" ? target.suffix : "");
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
