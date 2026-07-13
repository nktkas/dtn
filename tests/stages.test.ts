// deno-lint-ignore-file no-import-prefix

/**
 * Stage-level tests for vendoring and final Node-specifier rewriting.
 *
 * @module
 */

import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { dirname, join, toFileUrl } from "jsr:@std/path@^1";
import { analyze } from "../src/analyze.ts";
import { BuildError } from "../src/errors.ts";
import type { RawDependency, RawGraph, RawMediaType, RawModule } from "../src/graph.ts";
import type { Plan } from "../src/intake.ts";
import { relSpecifier } from "../src/spec.ts";
import { rewriteStage, vendorStage } from "../src/stages.ts";

const NETWORK = Deno.env.get("DTN_INTEGRATION") === "1";

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

Deno.test("rewriteStage — a vendor-emitted bare package ending in .ts is not changed to .js", async () => {
  const root = await Deno.makeTempDir({ prefix: "dtn-stages-" });
  try {
    // The vendor pass has already lowered npm:foo.ts@1 to the bare package "foo.ts";
    // only relative staged TypeScript paths may receive the deferred extension rewrite.
    const p = plan(root, { "foo.ts": "npm:other-pkg@1" });
    const remote = "https://jsr.io/@scope/pkg/1/mod.js";
    const a = analyze(
      p,
      graph([
        mod(toFileUrl(join(root, "src/mod.ts")).href, "TypeScript", [dep(remote, remote)]),
        mod(remote, "JavaScript", [dep("npm:foo.ts@1", "npm:foo.ts@1")]),
        mod("npm:foo.ts@1", undefined),
      ]),
    );

    await write(join(p.codeDir, "mod.js"), `import "${remote}";\nexport const a = 1;\n`);
    const remoteRel = a.vendoredCopies.get(remote)!;
    await write(join(p.codeDir, remoteRel), `import value from "foo.ts";\nexport default value;\n`);
    await rewriteStage(a);

    assertStringIncludes(await Deno.readTextFile(join(p.codeDir, "mod.js")), `import "./${remoteRel}"`);
    assertStringIncludes(await Deno.readTextFile(join(p.codeDir, remoteRel)), `from "foo.ts"`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("rewriteStage — the relative .ts → .js flip deferred by the vendor pass still applies to vendored files", async () => {
  const root = await Deno.makeTempDir({ prefix: "dtn-stages-" });
  try {
    // The alias makes the bare name "chalk" capturable; transpiled files and their `.d.ts` twins must stay exempt.
    const p = plan(root, { chalk: "npm:other-pkg@1" });
    const a = "https://jsr.io/@scope/pkg/1/a.ts";
    const b = "https://jsr.io/@scope/pkg/1/b.ts";
    const analysis = analyze(
      p,
      graph([
        mod(toFileUrl(join(root, "src/mod.ts")).href, "TypeScript", [dep(a, a)]),
        mod(a, "TypeScript", [dep("./b.ts", b)]),
        mod(b, "TypeScript"),
      ]),
    );

    // Vendor-transpile output: sibling references are still in `.ts` form, while non-relative specifiers are already final.
    const aEmit = analysis.vendoredCode.get(a)!.emit;
    const aSrc = analysis.vendoredCode.get(a)!.src;
    const bSrc = analysis.vendoredCode.get(b)!.src;
    const relativeSource = relSpecifier(aSrc, bSrc);
    await write(join(p.codeDir, aEmit), `import "${relativeSource}";\nimport chalk from "chalk";\n`);
    await write(
      join(p.codeDir, aEmit.replace(/\.js$/, ".d.ts")),
      `import "${relativeSource}";\nimport chalk from "chalk";\n`,
    );
    await rewriteStage(analysis);

    const js = await Deno.readTextFile(join(p.codeDir, aEmit));
    assertStringIncludes(js, `mod.js`);
    assertStringIncludes(js, `from "chalk"`);
    const dts = await Deno.readTextFile(join(p.codeDir, aEmit.replace(/\.js$/, ".d.ts")));
    assertStringIncludes(dts, `mod.js`);
    assertStringIncludes(dts, `from "chalk"`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("rewriteStage — generated declarations reject absolute file specifiers", async () => {
  const root = await Deno.makeTempDir({ prefix: "dtn-stages-" });
  try {
    const p = plan(root);
    const local = toFileUrl(join(root, "src/mod.ts")).href;
    const analysis = analyze(p, graph([mod(local, "TypeScript")]));
    const specifier = "file:///home/builder/.cache/deno/npm/registry.npmjs.org/zod/4.2.1/v4/index.d.cts";
    await write(join(p.codeDir, "mod.d.ts"), `export declare const schema: import("${specifier}").ZodType;\n`);

    const error = await assertRejects(() => rewriteStage(analysis), BuildError);
    assertEquals(error.code, "EMIT_FAILED");
    assertEquals(error.subject, specifier);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("vendorStage — a vendored map points back to the original JSR source", async () => {
  const root = await Deno.makeTempDir({ prefix: "dtn-stages-" });
  try {
    const p = plan(root);
    const local = toFileUrl(join(root, "src/mod.ts")).href;
    const remote = "https://jsr.io/@scope/pkg/1/mod.ts";
    const source = `export const answer: number = 42;\n`;
    const g: RawGraph = {
      modules: [
        mod(local, "TypeScript", [dep("jsr:@scope/pkg@1", remote)]),
        mod(remote, "TypeScript"),
      ],
      readSource: (specifier) => {
        if (specifier !== remote) return Promise.reject(new Error(`unexpected source ${specifier}`));
        return Promise.resolve(new TextEncoder().encode(source));
      },
    };
    const analysis = analyze(p, g);
    await vendorStage(analysis, g);

    const emit = analysis.vendoredCode.get(remote)!.emit;
    const map = JSON.parse(await Deno.readTextFile(join(p.codeDir, `${emit}.map`)));
    assertEquals(map.sources, [remote]);
    assertEquals(map.sourcesContent, [source]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name: "vendorStage — npm subpaths preserve declaration types",
  ignore: !NETWORK,
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "dtn-stages-" });
    try {
      const p = plan(root);
      const local = toFileUrl(join(root, "src/mod.ts")).href;
      const remote = "https://jsr.io/@scope/pkg/1/mod.ts";
      const npm = "npm:zod@4.2.1/v4";
      const source = `import { z } from "${npm}";\nexport const schema = z.literal("typed");\n`;
      const g: RawGraph = {
        modules: [
          mod(local, "TypeScript", [dep("jsr:@scope/pkg@1", remote)]),
          mod(remote, "TypeScript", [dep(npm, npm)]),
          mod(npm, undefined),
        ],
        readSource: (specifier) => {
          if (specifier !== remote) return Promise.reject(new Error(`unexpected source ${specifier}`));
          return Promise.resolve(new TextEncoder().encode(source));
        },
      };
      const analysis = analyze(p, g);
      await vendorStage(analysis, g);

      const emit = analysis.vendoredCode.get(remote)!.emit;
      const declaration = await Deno.readTextFile(join(p.codeDir, emit.replace(/\.js$/, ".d.ts")));
      assertStringIncludes(declaration, `import { z } from "zod/v4";`);
      assertStringIncludes(declaration, `schema: z.ZodLiteral<"typed">`);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test("vendorStage — retained JSR JavaScript, MJS, and declarations are staged and rewritten", async () => {
  const root = await Deno.makeTempDir({ prefix: "dtn-stages-" });
  try {
    const p = plan(root);
    const local = toFileUrl(join(root, "src/mod.ts")).href;
    const js = "https://jsr.io/@scope/pkg/1/mod.js";
    const mjs = "https://jsr.io/@scope/pkg/1/util.mjs";
    const dts = "https://jsr.io/@scope/pkg/1/types.d.ts";
    const sources = new Map([
      [js, `export { value } from "./util.mjs";\n//# sourceMappingURL=mod.js.map\n`],
      [mjs, `export const value = 1;\n/*@ sourceMappingURL=util.mjs.map */\n`],
      [dts, `export type Config = import("file:///author/types.d.ts").Config;\n`],
    ]);
    const g: RawGraph = {
      modules: [
        mod(local, "TypeScript", [
          dep("jsr:@scope/pkg@1", js),
          dep("jsr:@scope/pkg@1/types", dts),
        ]),
        mod(js, "JavaScript", [dep("./util.mjs", mjs)]),
        mod(mjs, "Mjs"),
        mod(dts, "Dts"),
      ],
      readSource: (specifier) => {
        const source = sources.get(specifier);
        return source === undefined
          ? Promise.reject(new Error(`unexpected source ${specifier}`))
          : Promise.resolve(new TextEncoder().encode(source));
      },
    };
    const analysis = analyze(p, g);
    await vendorStage(analysis, g);
    await rewriteStage(analysis);

    const jsRel = analysis.vendoredCopies.get(js)!;
    const mjsRel = analysis.vendoredCopies.get(mjs)!;
    const dtsRel = analysis.vendoredCopies.get(dts)!;
    const shipped = await Deno.readTextFile(join(p.codeDir, jsRel));
    assertStringIncludes(shipped, `from "${relSpecifier(jsRel, mjsRel)}"`);
    assertEquals(shipped.includes("@ts-nocheck"), false);
    assertEquals(shipped.includes("sourceMappingURL"), false);
    assertEquals((await Deno.readTextFile(join(p.codeDir, mjsRel))).includes("sourceMappingURL"), false);
    assertEquals(await Deno.readTextFile(join(p.codeDir, dtsRel)), sources.get(dts));
    assertStringIncludes(await Deno.readTextFile(join(p.tmpDir, jsRel)), "@ts-nocheck");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
