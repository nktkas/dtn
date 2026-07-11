// deno-lint-ignore-file no-import-prefix

/**
 * Stage-level tests for `rewriteStage`: what the second rewrite pass may and may not touch in vendor-emitted files.
 *
 * @module
 */

import { assertStringIncludes } from "jsr:@std/assert@1";
import { dirname, join, toFileUrl } from "jsr:@std/path@^1";
import { analyze } from "../src/analyze.ts";
import type { RawDependency, RawGraph, RawMediaType, RawModule } from "../src/graph.ts";
import type { Plan } from "../src/intake.ts";
import { rewriteStage } from "../src/stages.ts";

function plan(repoRoot: string, imports: Record<string, string> = {}): Plan {
  const outDir = join(repoRoot, "dist");
  return {
    repoRoot,
    outDir,
    codeDir: join(outDir, "esm"),
    tmpDir: join(outDir, ".dts-tmp"),
    name: "@x/lib",
    version: "1.0.0",
    exports: { ".": "./src/mod.ts" },
    imports,
    npmReplacements: {},
    packageJson: {},
    copyFiles: [],
    sourceMap: "separate",
    depsDir: "_deps",
  };
}

function mod(specifier: string, mediaType: RawMediaType | undefined, deps: RawDependency[] = []): RawModule {
  return { specifier, mediaType, error: undefined, dependencies: deps };
}

function dep(specifier: string, resolved: string | undefined): RawDependency {
  return { specifier, resolved };
}

function graph(modules: RawModule[]): RawGraph {
  return { modules, readSource: () => Promise.reject(new Error("readSource is not used by rewriteStage")) };
}

async function write(path: string, text: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, text);
}

Deno.test("rewriteStage — a vendor-emitted file keeps its finalized specifiers: an alias must not re-capture them", async () => {
  const root = await Deno.makeTempDir({ prefix: "dtn-stages-" });
  try {
    // A vendored module's npm:chalk@5, already lowered to the bare name "chalk", must not be captured by the alias —
    // in Deno a user alias never applies inside remote modules.
    const p = plan(root, { chalk: "npm:other-pkg@1" });
    const remote = "http://remote.test/mod.js";
    const a = analyze(
      p,
      graph([
        mod(toFileUrl(join(root, "src/mod.ts")).href, "TypeScript", [dep(remote, remote)]),
        mod(remote, "JavaScript", [dep("npm:chalk@5", "npm:chalk@5")]),
        mod("npm:chalk@5", undefined),
      ]),
    );

    await write(join(p.codeDir, "mod.js"), `import "${remote}";\nexport const a = 1;\n`);
    await write(join(p.codeDir, "_deps/remote.test/mod.js"), `import chalk from "chalk";\nexport default chalk;\n`);
    await rewriteStage(a);

    // The local emit resolves through the index; the vendored copy's bare name stays as the vendor pass wrote it.
    assertStringIncludes(await Deno.readTextFile(join(p.codeDir, "mod.js")), `import "./_deps/remote.test/mod.js"`);
    assertStringIncludes(await Deno.readTextFile(join(p.codeDir, "_deps/remote.test/mod.js")), `from "chalk"`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("rewriteStage — the relative .ts → .js flip deferred by the vendor pass still applies to vendored files", async () => {
  const root = await Deno.makeTempDir({ prefix: "dtn-stages-" });
  try {
    // The alias makes the bare name "chalk" capturable; transpiled files and their `.d.ts` twins must stay exempt.
    const p = plan(root, { chalk: "npm:other-pkg@1" });
    const a = "http://remote.test/a.ts";
    const b = "http://remote.test/b.ts";
    const analysis = analyze(
      p,
      graph([
        mod(toFileUrl(join(root, "src/mod.ts")).href, "TypeScript", [dep(a, a)]),
        mod(a, "TypeScript", [dep("./b.ts", b)]),
        mod(b, "TypeScript"),
      ]),
    );

    // Vendor-transpile output: sibling references still in `.ts` form, non-relative specifiers already final.
    await write(join(p.codeDir, "_deps/remote.test/a.js"), `import "./b.ts";\nimport chalk from "chalk";\n`);
    await write(join(p.codeDir, "_deps/remote.test/a.d.ts"), `import "./b.ts";\nimport chalk from "chalk";\n`);
    await rewriteStage(analysis);

    const js = await Deno.readTextFile(join(p.codeDir, "_deps/remote.test/a.js"));
    assertStringIncludes(js, `import "./b.js"`);
    assertStringIncludes(js, `from "chalk"`);
    const dts = await Deno.readTextFile(join(p.codeDir, "_deps/remote.test/a.d.ts"));
    assertStringIncludes(dts, `import "./b.js"`);
    assertStringIncludes(dts, `from "chalk"`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
