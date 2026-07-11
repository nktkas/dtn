// deno-lint-ignore-file no-import-prefix

/**
 * End-to-end builds through the real `deno transpile` + `@deno/graph`. Offline and loopback fixtures run on the
 * default `deno test` without external networking; the one fixture that fetches jsr.io is gated behind
 * DTN_INTEGRATION — run it with `deno task test:integration`.
 *
 * @module
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { exists } from "jsr:@std/fs@1";
import { dirname, fromFileUrl, join } from "jsr:@std/path@^1";
import { build, type BuildConfig, BuildError } from "../mod.ts";

// The CLI fixtures load cli.ts by file:// path; its bare specifiers (e.g. `@std/path`) resolve only through the
// engine's own deno.json import map, passed via --config.
const CONFIG = fromFileUrl(new URL("../deno.json", import.meta.url));
const NET = Deno.env.get("DTN_INTEGRATION") === "1"; // gates only the pinned-jsr fixture, which fetches jsr.io

interface BuildResult {
  dir: string;
  error: BuildError | null;
}

// Runs build() in-process, rooted at a temp fixture dir; a BuildError comes back typed. The fixture's deno.json is
// both written to disk (the transpile subprocess discovers compilerOptions from it) and passed as the config.
async function withBuild(
  files: Record<string, string>,
  buildCfg: Omit<BuildConfig, "denoJson" | "root">,
  fn: (r: BuildResult) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "dtn-it-" });
  try {
    for (const [rel, content] of Object.entries(files)) {
      const p = join(dir, rel);
      await Deno.mkdir(dirname(p), { recursive: true });
      await Deno.writeTextFile(p, content);
    }
    let error: BuildError | null = null;
    try {
      await build({ ...buildCfg, root: dir, denoJson: JSON.parse(files["deno.json"]) });
    } catch (e) {
      if (!(e instanceof BuildError)) throw e;
      error = e;
    }
    await fn({ dir, error });
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

// =============================================================================
// Offline fixtures
// =============================================================================

Deno.test("integration — pure-local project: transpile, rewrite, source maps, package.json", async (t) => {
  await withBuild(
    {
      "deno.json": JSON.stringify({ name: "@fx/a", version: "1.0.0", exports: { ".": "./src/mod.ts" } }),
      "src/util.ts": `export function helper(n: number): number {\n  return n * 2;\n}\n`,
      "src/mod.ts":
        `import { helper } from "./util.ts";\nexport function greet(n: number): number {\n  return helper(n);\n}\n`,
    },
    { outDir: "dist" },
    async ({ dir, error }) => {
      await t.step("the build succeeds", () => {
        assertEquals(error, null, error?.message);
      });

      await t.step("emits .js / .d.ts / .js.map per local source", async () => {
        for (const f of ["esm/mod.js", "esm/mod.d.ts", "esm/mod.js.map", "esm/util.js", "esm/util.d.ts"]) {
          assert(await exists(join(dir, "dist", f)), `missing ${f}`);
        }
      });

      await t.step("relative .ts import is rewritten to .js, with a sourceMappingURL", async () => {
        const js = await Deno.readTextFile(join(dir, "dist/esm/mod.js"));
        assertStringIncludes(js, `from "./util.js"`);
        assertStringIncludes(js, "//# sourceMappingURL=mod.js.map");
      });

      await t.step("package.json: ESM, exports map, root fields, no dependencies", async () => {
        const pkg = JSON.parse(await Deno.readTextFile(join(dir, "dist/package.json")));
        assertEquals(pkg.type, "module");
        assertEquals(pkg.exports["."], { types: "./esm/mod.d.ts", default: "./esm/mod.js" });
        assertEquals(pkg.main, "./esm/mod.js");
        assertEquals(pkg.types, "./esm/mod.d.ts");
        assertEquals("dependencies" in pkg, false);
      });
    },
  );
});

Deno.test("integration — dynamic import() and import.meta.resolve are rewritten through a real build", async (t) => {
  await withBuild(
    {
      "deno.json": JSON.stringify({ name: "@fx/dyn", version: "1.0.0", exports: { ".": "./src/mod.ts" } }),
      "src/util.ts": `export const x = 1;\n`,
      "src/mod.ts": `export async function load(): Promise<number> {\n` +
        `  const m = await import("./util.ts");\n  return m.x;\n}\n` +
        `export const here: string = import.meta.resolve("./util.ts");\n`,
    },
    { outDir: "dist" },
    async ({ dir, error }) => {
      await t.step("the build succeeds", () => assertEquals(error, null, error?.message));

      await t.step("both dynamic import() and import.meta.resolve() specifiers are rewritten .ts -> .js", async () => {
        const js = await Deno.readTextFile(join(dir, "dist/esm/mod.js"));
        assertStringIncludes(js, `import("./util.js")`);
        assertStringIncludes(js, `import.meta.resolve("./util.js")`);
      });
    },
  );
});

Deno.test("integration — a .d.ts-only entry point builds to a types-only export", async (t) => {
  await withBuild(
    {
      "deno.json": JSON.stringify({
        name: "@fx/dts",
        version: "1.0.0",
        exports: { ".": "./src/mod.ts", "./types": "./src/types.d.ts" },
      }),
      "src/types.d.ts": `export interface Config {\n  answer: number;\n}\n`,
      "src/mod.ts": `export const value = 42;\n`,
    },
    { outDir: "dist" },
    async ({ dir, error }) => {
      await t.step("the build succeeds", () => assertEquals(error, null, error?.message));

      await t.step("the .d.ts entry is copied verbatim, with no emitted .js for it", async () => {
        assert(await exists(join(dir, "dist/esm/types.d.ts")), "types.d.ts missing");
        assertEquals(await exists(join(dir, "dist/esm/types.js")), false, "a .d.ts entry must not emit a .js");
      });

      await t.step("package.json: the .d.ts entry is types-only (no default); the .ts entry has both", async () => {
        const pkg = JSON.parse(await Deno.readTextFile(join(dir, "dist/package.json")));
        assertEquals(pkg.exports["./types"], { types: "./esm/types.d.ts" });
        assertEquals(pkg.exports["."], { types: "./esm/mod.d.ts", default: "./esm/mod.js" });
      });
    },
  );
});

Deno.test("integration — local .js/.json sources are copied verbatim and their imports rewritten", async (t) => {
  await withBuild(
    {
      "deno.json": JSON.stringify({ name: "@fx/copy", version: "1.0.0", exports: { ".": "./src/mod.ts" } }),
      "src/data.json": `{ "answer": 42 }\n`,
      "src/util.ts": `export function helper(): number {\n  return 2;\n}\n`,
      "src/legacy.js": `export { helper } from "./util.ts";\nexport const legacy = 1;\n`,
      "src/mod.ts": `import data from "./data.json" with { type: "json" };\n` +
        `import { legacy } from "./legacy.js";\nexport const v = data.answer + legacy;\n`,
    },
    { outDir: "dist" },
    async ({ dir, error }) => {
      await t.step("the build succeeds", () => assertEquals(error, null, error?.message));

      await t.step("the .json source is copied byte-for-byte into esm/", async () => {
        assert(await exists(join(dir, "dist/esm/data.json")), "data.json not copied");
        assertEquals((await Deno.readTextFile(join(dir, "dist/esm/data.json"))).trim(), `{ "answer": 42 }`);
      });

      await t.step("the .js source is copied and its .ts import is rewritten to .js", async () => {
        assert(await exists(join(dir, "dist/esm/legacy.js")), "legacy.js not copied");
        assertStringIncludes(await Deno.readTextFile(join(dir, "dist/esm/legacy.js")), `from "./util.js"`);
      });
    },
  );
});

Deno.test("integration — copyFiles lands auxiliary files in the package root", async (t) => {
  await withBuild(
    {
      "deno.json": JSON.stringify({ name: "@fx/aux", version: "1.0.0", exports: { ".": "./src/mod.ts" } }),
      "src/mod.ts": `export const x = 1;\n`,
      "README.md": `# hi\n`,
      "LICENSE": `MIT\n`,
    },
    { outDir: "dist", copyFiles: ["README.md", "LICENSE"] },
    async ({ dir, error }) => {
      await t.step("the build succeeds", () => assertEquals(error, null, error?.message));

      await t.step("each copyFiles entry lands at the package root with its content", async () => {
        assertEquals(await Deno.readTextFile(join(dir, "dist/README.md")), `# hi\n`);
        assertEquals(await Deno.readTextFile(join(dir, "dist/LICENSE")), `MIT\n`);
      });
    },
  );
});

Deno.test("integration — a relative .d.ts import is preserved (not rewritten to .d.js)", async (t) => {
  await withBuild(
    {
      "deno.json": JSON.stringify({ name: "@fx/dtsimp", version: "1.0.0", exports: { ".": "./src/mod.ts" } }),
      "src/types.d.ts": `export interface T {\n  v: number;\n}\n`,
      "src/mod.ts": `import type { T } from "./types.d.ts";\nexport function make(): T {\n  return { v: 1 };\n}\n`,
    },
    { outDir: "dist" },
    async ({ dir, error }) => {
      await t.step("the build succeeds", () => assertEquals(error, null, error?.message));

      await t.step(
        "the .d.ts specifier stays `./types.d.ts` in the emitted declaration (not `./types.d.js`)",
        async () => {
          const dts = await Deno.readTextFile(join(dir, "dist/esm/mod.d.ts"));
          assertStringIncludes(dts, `"./types.d.ts"`);
          assert(!dts.includes("./types.d.js"), "a relative .d.ts import must not be rewritten to .d.js");
        },
      );
    },
  );
});

Deno.test('integration — a JSON import keeps its `with { type: "json" }` attribute in the emitted .d.ts', async (t) => {
  await withBuild(
    {
      "deno.json": JSON.stringify({ name: "@fx/jsonattr", version: "1.0.0", exports: { ".": "./src/mod.ts" } }),
      "src/data.json": `{ "answer": 42 }\n`,
      "src/mod.ts": `export { default as config } from "./data.json" with { type: "json" };\n`,
    },
    { outDir: "dist" },
    async ({ dir, error }) => {
      await t.step("the build succeeds", () => assertEquals(error, null, error?.message));

      await t.step("restoreJsonAttributes re-adds the attribute the declaration emit drops", async () => {
        // The .js import is rewritten `.json` → still `.json`; the .d.ts re-export must carry `with { type: "json" }`.
        const dts = await Deno.readTextFile(join(dir, "dist/esm/mod.d.ts"));
        assertStringIncludes(dts, `from "./data.json" with { type: "json" }`);
      });
    },
  );
});

Deno.test("integration — a config violation raised before any write leaves a prior build intact", async () => {
  await withBuild(
    {
      // A `.js` entry point is rejected by intake (INVALID_EXPORTS) before the output is touched.
      "deno.json": JSON.stringify({ name: "@fx/c", version: "1.0.0", exports: { ".": "./src/mod.js" } }),
      "src/mod.ts": `export const x = 1;\n`,
      "dist/SENTINEL.txt": "previous build",
    },
    { outDir: "dist" },
    async ({ dir, error }) => {
      assertEquals(error?.code, "INVALID_EXPORTS");
      assertEquals(
        await Deno.readTextFile(join(dir, "dist/SENTINEL.txt")),
        "previous build",
        "the prior build must be left intact",
      );
    },
  );
});

Deno.test("integration — documented limitations fail loudly (not silently mis-built)", async (t) => {
  await t.step(
    "a hostless remote dependency (a data: URL) is rejected (UNSUPPORTED_VENDORED_DEPENDENCY)",
    async () => {
      // A data: URL has no host+pathname to mirror under _deps, so the build fails loudly — a deterministic, offline
      // check of that boundary (it cannot pass through either: the declaration pass cannot resolve a data: URL to a path).
      await withBuild(
        {
          "deno.json": JSON.stringify({ name: "@fx/d2", version: "1.0.0", exports: { ".": "./src/mod.ts" } }),
          "src/mod.ts": `import x from "data:text/javascript,export default 1";\nexport const v = x;\n`,
        },
        { outDir: "dist" },
        ({ error }) => {
          assertEquals(error?.code, "UNSUPPORTED_VENDORED_DEPENDENCY");
          return Promise.resolve();
        },
      );
    },
  );

  await t.step("a deno.json `scopes` entry the resolver ignores fails the build", async () => {
    await withBuild(
      {
        "deno.json": JSON.stringify({
          name: "@fx/d3",
          version: "1.0.0",
          exports: { ".": "./src/mod.ts" },
          scopes: { "./src/": { "scoped-only": "npm:chalk@^5" } },
        }),
        "src/mod.ts": `import chalk from "scoped-only";\nexport const v = chalk;\n`,
      },
      { outDir: "dist" },
      ({ error }) => {
        // scopes is unsupported, so the import fails to resolve and the build fails loudly. The contract guarantees the
        // loud failure, not a specific code, so assert a typed BuildError without pinning which one.
        assert(error !== null, "scopes-dependent import should fail the build");
        return Promise.resolve();
      },
    );
  });
});

Deno.test("integration — a types-only project (every export is a .d.ts) builds without a transpile pass", async (t) => {
  await withBuild(
    {
      // No `.ts` source at all → localFiles is empty → the transpile pass must be SKIPPED. Invoking `deno transpile`
      // with zero files would fail, so the `localFiles.length > 0` guard is load-bearing for a types-only package.
      "deno.json": JSON.stringify({ name: "@fx/typesonly", version: "1.0.0", exports: { ".": "./types.d.ts" } }),
      "types.d.ts": `export interface Config {\n  answer: number;\n}\n`,
    },
    { outDir: "dist" },
    async ({ dir, error }) => {
      await t.step("the build succeeds", () => assertEquals(error, null, error?.message));

      await t.step("the .d.ts is copied and the export is types-only", async () => {
        assert(await exists(join(dir, "dist/esm/types.d.ts")), "types.d.ts missing");
        const pkg = JSON.parse(await Deno.readTextFile(join(dir, "dist/package.json")));
        assertEquals(pkg.exports["."], { types: "./esm/types.d.ts" });
      });
    },
  );
});

Deno.test("integration — a duplicate copyFiles entry overwrites rather than conflicting", async (t) => {
  await withBuild(
    {
      "deno.json": JSON.stringify({ name: "@fx/dup", version: "1.0.0", exports: { ".": "./src/mod.ts" } }),
      "src/mod.ts": `export const x = 1;\n`,
      "README.md": `# dup\n`,
    },
    // The same entry twice: the second copy targets a destination the first already created in this build, so it must
    // overwrite (overwrite: true) — not fail with AlreadyExists.
    { outDir: "dist", copyFiles: ["README.md", "README.md"] },
    async ({ dir, error }) => {
      await t.step("the build succeeds (the second copy overwrites)", () => assertEquals(error, null, error?.message));

      await t.step("the file lands at the package root with its content", async () => {
        assertEquals(await Deno.readTextFile(join(dir, "dist/README.md")), `# dup\n`);
      });
    },
  );
});

Deno.test("integration — a directory whose name ends in a tracked extension is not read as a file", async (t) => {
  await withBuild(
    {
      // A source nested under a directory literally named `widget.ts`. The rewrite walk lists code files by extension,
      // and `@std/fs` walk matches `exts` against directory names too — so this dir would be yielded and read as a file
      // unless `includeDirs: false`. A valid project may nest sources this way, so the build must still succeed.
      "deno.json": JSON.stringify({ name: "@fx/direxts", version: "1.0.0", exports: { ".": "./src/mod.ts" } }),
      "src/widget.ts/impl.ts": `export const w = 1;\n`,
      "src/mod.ts": `import { w } from "./widget.ts/impl.ts";\nexport const v = w;\n`,
    },
    { outDir: "dist" },
    async ({ dir, error }) => {
      await t.step("the build succeeds despite a `.ts`-named directory under the code root", () => {
        assertEquals(error, null, error?.message);
      });

      await t.step("the nested source transpiles and its import is rewritten .ts -> .js", async () => {
        assert(await exists(join(dir, "dist/esm/widget.ts/impl.js")), "nested impl.js missing");
        assertStringIncludes(await Deno.readTextFile(join(dir, "dist/esm/mod.js")), `from "./widget.ts/impl.js"`);
      });
    },
  );
});

Deno.test("integration — sourceMap: inline embeds a rebased map in the .js, with no separate .js.map", async (t) => {
  await withBuild(
    {
      "deno.json": JSON.stringify({ name: "@fx/sm", version: "1.0.0", exports: { ".": "./src/mod.ts" } }),
      "src/mod.ts": `export function inc(n: number): number {\n  return n + 1;\n}\n`,
    },
    { outDir: "dist", sourceMap: "inline" },
    async ({ dir, error }) => {
      await t.step("the build succeeds", () => assertEquals(error, null, error?.message));

      await t.step("the .js carries an inline map and no separate .js.map is emitted", async () => {
        const js = await Deno.readTextFile(join(dir, "dist/esm/mod.js"));
        assertStringIncludes(js, "//# sourceMappingURL=data:application/json;base64,");
        assertEquals(await exists(join(dir, "dist/esm/mod.js.map")), false);
      });
    },
  );
});

Deno.test("integration — sourceMap: none emits neither a .js.map nor a sourceMappingURL", async (t) => {
  await withBuild(
    {
      "deno.json": JSON.stringify({ name: "@fx/smn", version: "1.0.0", exports: { ".": "./src/mod.ts" } }),
      "src/mod.ts": `export function inc(n: number): number {\n  return n + 1;\n}\n`,
    },
    { outDir: "dist", sourceMap: "none" },
    async ({ dir, error }) => {
      await t.step("the build succeeds", () => assertEquals(error, null, error?.message));

      await t.step("no separate map is emitted and the .js carries no sourceMappingURL", async () => {
        assertEquals(await exists(join(dir, "dist/esm/mod.js.map")), false);
        const js = await Deno.readTextFile(join(dir, "dist/esm/mod.js"));
        assert(!js.includes("sourceMappingURL"), "sourceMap: none must not emit a sourceMappingURL");
      });
    },
  );
});

Deno.test("integration — wildcard exports (`./*`) expand to explicit per-file entries", async (t) => {
  await withBuild(
    {
      "deno.json": JSON.stringify({ name: "@fx/wild", version: "1.0.0", exports: { "./*": "./src/*.ts" } }),
      "src/a.ts": `export const a = 1;\n`,
      "src/b.ts": `import { a } from "./a.ts";\nexport const b = a + 1;\n`,
      "src/types.d.ts": `export interface T {\n  v: number;\n}\n`,
    },
    { outDir: "dist" },
    async ({ dir, error }) => {
      await t.step("the build succeeds", () => assertEquals(error, null, error?.message));

      await t.step("each matched source is built, and a relative import is rewritten", async () => {
        for (const f of ["esm/a.js", "esm/a.d.ts", "esm/b.js", "esm/b.d.ts", "esm/types.d.ts"]) {
          assert(await exists(join(dir, "dist", f)), `missing ${f}`);
        }
        assertStringIncludes(await Deno.readTextFile(join(dir, "dist/esm/b.js")), `from "./a.js"`);
      });

      await t.step("package.json lists one explicit entry per matched file; the .d.ts is types-only", async () => {
        const pkg = JSON.parse(await Deno.readTextFile(join(dir, "dist/package.json")));
        assertEquals(pkg.exports, {
          "./a": { types: "./esm/a.d.ts", default: "./esm/a.js" },
          "./b": { types: "./esm/b.d.ts", default: "./esm/b.js" },
          "./types.d": { types: "./esm/types.d.ts" },
        });
      });
    },
  );
});

Deno.test("integration — import-map aliases to local files are resolved and rewritten to relative paths", async (t) => {
  await withBuild(
    {
      // `$util` (exact alias) and `@dir/` (prefix alias) both map to local files. The relative targets resolve against
      // the deno.json base, so the alias imports build and rewrite to relative `.js` — the alias namespace disappears.
      "deno.json": JSON.stringify({
        name: "@fx/localalias",
        version: "1.0.0",
        exports: { ".": "./src/mod.ts" },
        imports: { "$util": "./src/util.ts", "@dir/": "./src/sub/" },
      }),
      "src/util.ts": `export const u = 1;\n`,
      "src/sub/helper.ts": `export const h = 2;\n`,
      "src/mod.ts": `import { u } from "$util";\nimport { h } from "@dir/helper.ts";\nexport const x = u + h;\n`,
    },
    { outDir: "dist" },
    async ({ dir, error }) => {
      await t.step("the build succeeds", () => assertEquals(error, null, error?.message));

      await t.step("both the exact and the prefix alias import are rewritten to relative .js paths", async () => {
        const js = await Deno.readTextFile(join(dir, "dist/esm/mod.js"));
        assertStringIncludes(js, `from "./util.js"`);
        assertStringIncludes(js, `from "./sub/helper.js"`);
      });

      await t.step("the aliased local sources are emitted under esm/", async () => {
        for (const f of ["esm/util.js", "esm/sub/helper.js"]) {
          assert(await exists(join(dir, "dist", f)), `missing ${f}`);
        }
      });
    },
  );
});

Deno.test("integration — the CLI reads deno.json, parses flags, and builds the package", async () => {
  const cli = fromFileUrl(new URL("../cli.ts", import.meta.url));
  const dir = await Deno.makeTempDir({ prefix: "dtn-cli-" });
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ name: "@fx/cli", version: "1.0.0", exports: "./src/mod.ts" }),
    );
    await Deno.writeTextFile(join(dir, "src/util.ts"), "export const u: number = 1;\n");
    await Deno.writeTextFile(
      join(dir, "src/mod.ts"),
      `import { u } from "./util.ts";\nexport const v: number = u + 1;\n`,
    );
    await Deno.writeTextFile(join(dir, "README.md"), "# hi\n");
    const { code, stderr } = await new Deno.Command("deno", {
      args: ["run", "-A", "--config", CONFIG, cli, "--out-dir", "out", "--copy", "README.md", "--source-map", "none"],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(code, 0, new TextDecoder().decode(stderr));
    assert(await exists(join(dir, "out/esm/mod.js")), "mod.js missing");
    assert(await exists(join(dir, "out/package.json")), "package.json missing");
    assert(await exists(join(dir, "out/README.md")), "the --copy file is missing");
    assertEquals(await exists(join(dir, "out/esm/mod.js.map")), false, "--source-map none must not emit a .js.map");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("integration — CLI --deno-json in a subdirectory: config paths follow the config, outDir follows cwd", async () => {
  const cli = fromFileUrl(new URL("../cli.ts", import.meta.url));
  const dir = await Deno.makeTempDir({ prefix: "dtn-cli-" });
  try {
    await Deno.mkdir(join(dir, "packages/lib/src/sub"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "packages/lib/deno.json"),
      JSON.stringify({
        name: "@fx/rebase",
        version: "1.0.0",
        exports: "./src/mod.ts",
        imports: { "$util": "./src/util.ts", "@dir/": "./src/sub/" },
      }),
    );
    await Deno.writeTextFile(join(dir, "packages/lib/src/util.ts"), "export const u: number = 1;\n");
    await Deno.writeTextFile(join(dir, "packages/lib/src/sub/helper.ts"), "export const h: number = 2;\n");
    await Deno.writeTextFile(
      join(dir, "packages/lib/src/mod.ts"),
      `import { u } from "$util";\nimport { h } from "@dir/helper.ts";\nexport const v: number = u + h;\n`,
    );
    const { code, stderr } = await new Deno.Command("deno", {
      args: ["run", "-A", "--config", CONFIG, cli, "--deno-json", "packages/lib/deno.json", "--out-dir", "dist"],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(code, 0, new TextDecoder().decode(stderr));
    assert(await exists(join(dir, "dist/esm/mod.js")), "mod.js missing");
    assert(await exists(join(dir, "dist/esm/util.js")), "the import-map-aliased util.js missing");
    assert(await exists(join(dir, "dist/esm/sub/helper.js")), "the folder-prefix-aliased helper.js missing");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("integration — build({ root }) builds a project in-process from elsewhere", async () => {
  const dir = await Deno.makeTempDir({ prefix: "dtn-root-" });
  try {
    await Deno.mkdir(join(dir, "proj/src"), { recursive: true });
    await Deno.writeTextFile(join(dir, "proj/src/mod.ts"), "export const n: number = 3;\n");
    await build({
      root: join(dir, "proj"),
      outDir: "dist",
      denoJson: { name: "@fx/root", version: "1.0.0", exports: "./src/mod.ts" },
    });
    // outDir resolves against the root.
    assert(await exists(join(dir, "proj/dist/esm/mod.js")), "mod.js missing");
    assert(await exists(join(dir, "proj/dist/package.json")), "package.json missing");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("integration — build({ root }) inherits the target project's compilerOptions, typed error in-process", async () => {
  const dir = await Deno.makeTempDir({ prefix: "dtn-root-" });
  try {
    await Deno.mkdir(join(dir, "proj/src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "proj/deno.json"),
      JSON.stringify({ compilerOptions: { noUnusedLocals: true } }),
    );
    await Deno.writeTextFile(
      join(dir, "proj/src/mod.ts"),
      "export function f(): number {\n  const unused = 1;\n  return 2;\n}\n",
    );
    const e = await assertRejects(
      () =>
        build({
          root: join(dir, "proj"),
          outDir: "dist",
          denoJson: { name: "@fx/rootstrict", version: "1.0.0", exports: "./src/mod.ts" },
        }),
      BuildError,
    );
    assertEquals(e.code, "TRANSPILE_FAILED");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("integration — CLI --deno-json outside cwd builds the config's project", async () => {
  const cli = fromFileUrl(new URL("../cli.ts", import.meta.url));
  const dir = await Deno.makeTempDir({ prefix: "dtn-cli-" });
  try {
    await Deno.mkdir(join(dir, "proj/src"), { recursive: true });
    await Deno.mkdir(join(dir, "work"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "proj/deno.json"),
      JSON.stringify({
        name: "@fx/away",
        version: "1.0.0",
        exports: "./src/mod.ts",
        imports: { "$util": "./src/util.ts" },
      }),
    );
    await Deno.writeTextFile(join(dir, "proj/src/util.ts"), "export const u: number = 1;\n");
    await Deno.writeTextFile(
      join(dir, "proj/src/mod.ts"),
      `import { u } from "$util";\nexport const v: number = u + 1;\n`,
    );
    const { code, stderr } = await new Deno.Command("deno", {
      args: ["run", "-A", "--config", CONFIG, cli, "--deno-json", "../proj/deno.json", "--out-dir", "dist"],
      cwd: join(dir, "work"),
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(code, 0, new TextDecoder().decode(stderr));
    // outDir keeps its cwd-relative CLI meaning even when the project root is elsewhere.
    assert(await exists(join(dir, "work/dist/esm/mod.js")), "mod.js missing");
    assert(await exists(join(dir, "work/dist/esm/util.js")), "util.js missing");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("integration — the local pass inherits the project's compilerOptions (a violation fails the build)", async (t) => {
  await withBuild(
    {
      "deno.json": JSON.stringify({
        name: "@fx/strict",
        version: "1.0.0",
        exports: { ".": "./src/mod.ts" },
        compilerOptions: { noUnusedLocals: true },
      }),
      "src/mod.ts": `export function f(): number {\n  const unused = 1;\n  return 2;\n}\n`,
    },
    { outDir: "dist" },
    async ({ error }) => {
      await t.step("fails as TRANSPILE_FAILED, exactly as deno check would", () => {
        assertEquals(error?.code, "TRANSPILE_FAILED");
      });

      await t.step("the compiler diagnostic leads the error message; the command echo trails it", () => {
        assert(error !== null);
        const diag = error.message.indexOf("TS6133");
        const echo = error.message.indexOf("exited with");
        assert(diag !== -1 && echo !== -1, error.message);
        assert(diag < echo, "the diagnostic must not be buried under the command echo");
      });
    },
  );
});

// =============================================================================
// Loopback fixtures
// =============================================================================

Deno.test({
  name: "integration — a public type derived from a vendored remote asset is type-checked, not `any`",
  fn: async () => {
    // A local server stands in for a remote JSON asset with no npm twin (so it is vendored). The engine must stage the
    // asset into the scratch tree, or the declaration pass cannot resolve it and the inferred type degrades to `any`.
    // Bind and fetch the literal 127.0.0.1 so name resolution (and a possible IPv6 `localhost`) is out of the path.
    const ac = new AbortController();
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen: () => {} },
      () => new Response(JSON.stringify({ answer: 42 }), { headers: { "content-type": "application/json" } }),
    );
    const { hostname, port } = server.addr as Deno.NetAddr;
    try {
      await withBuild(
        {
          "deno.json": JSON.stringify({ name: "@fx/asset", version: "1.0.0", exports: { ".": "./src/mod.ts" } }),
          "src/mod.ts": `import config from "http://${hostname}:${port}/data.json" with { type: "json" };\n` +
            `export const answer = config.answer;\n`,
        },
        { outDir: "dist" },
        async ({ dir, error }) => {
          assertEquals(error, null, error?.message);
          // `any` here would mean the vendored asset was absent during the type-check.
          assertStringIncludes(
            await Deno.readTextFile(join(dir, "dist/esm/mod.d.ts")),
            "export declare const answer: number;",
          );
        },
      );
    } finally {
      ac.abort();
      await server.finished;
    }
  },
});

Deno.test({
  name: "integration — a remote JavaScript module is vendored under _deps and rewritten",
  fn: async () => {
    // The engine vendors a remote JS module verbatim (nothing to transpile) and rewrites its specifiers; its types
    // degrade to `any` (accepted). The server serves the module and a relative sibling it imports.
    const ac = new AbortController();
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen: () => {} },
      (req) => {
        const js = { headers: { "content-type": "text/javascript; charset=utf-8" } };
        const path = new URL(req.url).pathname;
        if (path === "/mod.js") return new Response(`export { helper } from "./util.js";\nexport const v = 1;\n`, js);
        if (path === "/util.js") return new Response(`export function helper() {\n  return 2;\n}\n`, js);
        return new Response("not found", { status: 404 });
      },
    );
    const { hostname, port } = server.addr as Deno.NetAddr;
    try {
      await withBuild(
        {
          "deno.json": JSON.stringify({ name: "@fx/remotejs", version: "1.0.0", exports: { ".": "./src/mod.ts" } }),
          "src/mod.ts": `import { helper, v } from "http://${hostname}:${port}/mod.js";\n` +
            `export const x: number = helper() + v;\n`,
        },
        { outDir: "dist" },
        async ({ dir, error }) => {
          assertEquals(error, null, error?.message);
          const dep = `esm/_deps/${hostname}:${port}`;
          // The remote module and its sibling are inlined verbatim under _deps; the sibling import stays relative.
          assertStringIncludes(await Deno.readTextFile(join(dir, "dist", dep, "mod.js")), `from "./util.js"`);
          assert(await exists(join(dir, "dist", dep, "util.js")), "vendored sibling util.js missing");
          // The local importer's specifier is rewritten to the relative vendored path.
          assertStringIncludes(
            await Deno.readTextFile(join(dir, "dist/esm/mod.js")),
            `from "./_deps/${hostname}:${port}/mod.js"`,
          );
        },
      );
    } finally {
      ac.abort();
      await server.finished;
    }
  },
});

Deno.test({
  name: "integration — a remote .d.ts is vendored and its types are preserved",
  fn: async () => {
    // A remote `.d.ts` is vendored like a JS copy, but it carries real types: the importing module's emitted `.d.ts`
    // keeps the type (not `any`) and points at the vendored declaration, while the runtime `import type` is erased.
    const ac = new AbortController();
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen: () => {} },
      () =>
        new Response(`export interface Config {\n  answer: number;\n}\n`, {
          headers: { "content-type": "application/typescript; charset=utf-8" },
        }),
    );
    const { hostname, port } = server.addr as Deno.NetAddr;
    try {
      await withBuild(
        {
          "deno.json": JSON.stringify({ name: "@fx/remotedts", version: "1.0.0", exports: { ".": "./src/mod.ts" } }),
          "src/mod.ts": `import type { Config } from "http://${hostname}:${port}/types.d.ts";\n` +
            `export const x: Config = { answer: 1 };\n`,
        },
        { outDir: "dist" },
        async ({ dir, error }) => {
          assertEquals(error, null, error?.message);
          const dep = `esm/_deps/${hostname}:${port}`;
          assert(await exists(join(dir, "dist", dep, "types.d.ts")), "vendored types.d.ts missing");
          const dts = await Deno.readTextFile(join(dir, "dist/esm/mod.d.ts"));
          assertStringIncludes(dts, `from "./_deps/${hostname}:${port}/types.d.ts"`);
          assertStringIncludes(dts, "export declare const x: Config;"); // type preserved, not `any`
          const js = await Deno.readTextFile(join(dir, "dist/esm/mod.js"));
          assert(!js.includes("types.d.ts"), "a type-only import must be erased from the emitted .js");
        },
      );
    } finally {
      ac.abort();
      await server.finished;
    }
  },
});

Deno.test({
  name: "integration — the vendor pass is hermetic: consumer compilerOptions must not fail third-party code",
  fn: async () => {
    // Third-party code must never be type-checked under the CONSUMER's compilerOptions — neither by the vendor pass
    // (which discovers the user's deno.json from its cwd ancestors) nor by the local declaration pass (which reaches
    // vendored modules while checking the author's sources). Two files pin the multi-module case.
    const ts = { headers: { "content-type": "application/typescript; charset=utf-8" } };
    const ac = new AbortController();
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen: () => {} },
      (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/dep.ts") {
          return new Response(
            `import { util } from "./util.ts";\nexport function helper(): number {\n  const unused = 1;\n  return util();\n}\n`,
            ts,
          );
        }
        if (path === "/util.ts") {
          return new Response(`export function util(): number {\n  const unusedToo = 2;\n  return 3;\n}\n`, ts);
        }
        return new Response("not found", { status: 404 });
      },
    );
    const { hostname, port } = server.addr as Deno.NetAddr;
    try {
      await withBuild(
        {
          "deno.json": JSON.stringify({
            name: "@fx/hermetic",
            version: "1.0.0",
            exports: { ".": "./src/mod.ts" },
            compilerOptions: { noUnusedLocals: true },
          }),
          "src/mod.ts": `export { helper } from "http://${hostname}:${port}/dep.ts";\n`,
        },
        { outDir: "dist" },
        async ({ dir, error }) => {
          assertEquals(error, null, error?.message);
          assert(await exists(join(dir, `dist/esm/_deps/${hostname}:${port}/dep.js`)), "vendored dep.js missing");
          assert(await exists(join(dir, `dist/esm/_deps/${hostname}:${port}/util.js`)), "vendored util.js missing");
        },
      );
    } finally {
      ac.abort();
      await server.finished;
    }
  },
});

Deno.test({
  name: "integration — a vendored .js copy is also exempt from consumer compilerOptions (checkJs)",
  fn: async () => {
    const ac = new AbortController();
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen: () => {} },
      () =>
        new Response(`export function helper() {\n  const unused = 1;\n  return 2;\n}\n`, {
          headers: { "content-type": "text/javascript; charset=utf-8" },
        }),
    );
    const { hostname, port } = server.addr as Deno.NetAddr;
    try {
      await withBuild(
        {
          "deno.json": JSON.stringify({
            name: "@fx/checkjs",
            version: "1.0.0",
            exports: { ".": "./src/mod.ts" },
            compilerOptions: { checkJs: true, noUnusedLocals: true },
          }),
          "src/mod.ts": `export { helper } from "http://${hostname}:${port}/dep.js";\n`,
        },
        { outDir: "dist" },
        async ({ dir, error }) => {
          assertEquals(error, null, error?.message);
          // The SHIPPED copy stays clean — @ts-nocheck belongs only to the scratch-tree copy the checker reads.
          const shipped = await Deno.readTextFile(join(dir, `dist/esm/_deps/${hostname}:${port}/dep.js`));
          assert(!shipped.includes("@ts-nocheck"), "the shipped vendored copy must not carry @ts-nocheck");
        },
      );
    } finally {
      ac.abort();
      await server.finished;
    }
  },
});

Deno.test({
  name: "integration — a remote TypeScript module served from an extensionless URL is vendored and reachable",
  fn: async () => {
    // The media type comes from the Content-Type header, not the URL path, so an extensionless TypeScript URL is
    // valid Deno; the vendored copy must still transpile to a `.js` the rewritten imports can reach.
    const ac = new AbortController();
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen: () => {} },
      () =>
        new Response(`export const answer: number = 7;\n`, {
          headers: { "content-type": "application/typescript; charset=utf-8" },
        }),
    );
    const { hostname, port } = server.addr as Deno.NetAddr;
    try {
      await withBuild(
        {
          "deno.json": JSON.stringify({ name: "@fx/noext", version: "1.0.0", exports: { ".": "./src/mod.ts" } }),
          "src/mod.ts": `export { answer } from "http://${hostname}:${port}/dep";\n`,
        },
        { outDir: "dist" },
        async ({ dir, error }) => {
          assertEquals(error, null, error?.message);
          const dep = `esm/_deps/${hostname}:${port}`;
          assert(await exists(join(dir, "dist", dep, "dep.js")), "vendored dep.js missing");
          assertStringIncludes(
            await Deno.readTextFile(join(dir, "dist/esm/mod.js")),
            `from "./_deps/${hostname}:${port}/dep.js"`,
          );
        },
      );
    } finally {
      ac.abort();
      await server.finished;
    }
  },
});

Deno.test({
  name: "integration — a remote redirect chain is followed to its final module",
  fn: async () => {
    // A CLI-populated cache stores each redirect hop separately, so the redirects table chains (a → b, b → c) and
    // must be followed to its end. The fixture pre-caches via `deno cache` to get that state.
    const ac = new AbortController();
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen: () => {} },
      (req) => {
        const path = new URL(req.url).pathname;
        const origin = new URL(req.url).origin;
        if (path === "/a.ts") return new Response(null, { status: 302, headers: { location: `${origin}/b.ts` } });
        if (path === "/b.ts") return new Response(null, { status: 302, headers: { location: `${origin}/c.ts` } });
        if (path === "/c.ts") {
          return new Response(`export const fromChain: number = 7;\n`, {
            headers: { "content-type": "application/typescript; charset=utf-8" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    );
    const { hostname, port } = server.addr as Deno.NetAddr;
    try {
      const cache = await new Deno.Command("deno", {
        args: ["cache", `http://${hostname}:${port}/a.ts`],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(cache.code, 0, new TextDecoder().decode(cache.stderr));

      await withBuild(
        {
          "deno.json": JSON.stringify({ name: "@fx/redirect", version: "1.0.0", exports: { ".": "./src/mod.ts" } }),
          "src/mod.ts": `export { fromChain } from "http://${hostname}:${port}/a.ts";\n`,
        },
        { outDir: "dist" },
        async ({ dir, error }) => {
          assertEquals(error, null, error?.message);
          const dep = `esm/_deps/${hostname}:${port}`;
          // The module is vendored under its FINAL URL, and the local importer points at it.
          assert(await exists(join(dir, "dist", dep, "c.js")), "vendored c.js (the chain's end) missing");
          assertStringIncludes(
            await Deno.readTextFile(join(dir, "dist/esm/mod.js")),
            `from "./_deps/${hostname}:${port}/c.js"`,
          );
        },
      );
    } finally {
      ac.abort();
      await server.finished;
    }
  },
});

// =============================================================================
// Network fixture
// =============================================================================

Deno.test({
  name: "integration — vendoring + npm-external + multi-entry (network, pinned jsr)",
  ignore: !NET,
  fn: async (t) => {
    await withBuild(
      {
        "deno.json": JSON.stringify({
          name: "@fx/b",
          version: "2.0.0",
          exports: { ".": "./src/mod.ts", "./sub": "./src/sub.ts" },
          imports: { "@std/encoding/hex": "jsr:@std/encoding@1.0.10/hex", chalk: "npm:chalk@^5" },
        }),
        "src/util.ts": `export function helper(n: number): number {\n  return n * 2;\n}\n`,
        "src/mod.ts":
          `import { encodeHex } from "@std/encoding/hex";\nimport chalk from "chalk";\nimport { helper } from "./util.ts";\nexport function greet(x: number): string {\n  return chalk.green(encodeHex(new Uint8Array([helper(x)])));\n}\n`,
        "src/sub.ts": `import { helper } from "./util.ts";\nexport const doubled = helper(21);\n`,
      },
      { outDir: "dist" },
      async ({ dir, error }) => {
        await t.step("the build succeeds", () => assertEquals(error, null, error?.message));

        await t.step("the jsr dependency is vendored under _deps at its pinned version (.js + .d.ts)", async () => {
          const base = "dist/esm/_deps/jsr.io/@std/encoding/1.0.10/hex";
          assert(await exists(join(dir, `${base}.js`)), "vendored hex.js missing");
          assert(await exists(join(dir, `${base}.d.ts`)), "vendored hex.d.ts missing");
        });

        await t.step("the vendored module's emitted .d.ts retains real types (not `any`)", async () => {
          // The pipeline's headline 'types survive for vendored deps' promise: encodeHex keeps a typed signature.
          const dts = await Deno.readTextFile(join(dir, "dist/esm/_deps/jsr.io/@std/encoding/1.0.10/hex.d.ts"));
          assertStringIncludes(dts, "encodeHex");
          assert(!/encodeHex\([^)]*\)\s*:\s*any/.test(dts), "encodeHex must keep its real type, not degrade to any");
        });

        await t.step("imports are rewritten: vendored → relative _deps path, npm → bare name", async () => {
          const js = await Deno.readTextFile(join(dir, "dist/esm/mod.js"));
          assertStringIncludes(js, `from "./_deps/jsr.io/@std/encoding/1.0.10/hex.js"`);
          assertStringIncludes(js, `from "chalk"`);
          assertStringIncludes(js, `from "./util.js"`);
        });

        await t.step("package.json: npm-external declared, both entry points pinned to their full values", async () => {
          const pkg = JSON.parse(await Deno.readTextFile(join(dir, "dist/package.json")));
          assertEquals(pkg.dependencies, { chalk: "^5" });
          assertEquals(pkg.exports["."], { types: "./esm/mod.d.ts", default: "./esm/mod.js" });
          assertEquals(pkg.exports["./sub"], { types: "./esm/sub.d.ts", default: "./esm/sub.js" });
          assert(await exists(join(dir, "dist/esm/sub.d.ts")), "sub.d.ts missing");
        });

        await t.step("the scratch tmp tree is cleaned up", async () => {
          assertEquals(await exists(join(dir, "dist/.dts-tmp")), false);
        });
      },
    );
  },
});
