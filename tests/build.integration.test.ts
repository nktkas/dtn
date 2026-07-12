// deno-lint-ignore-file no-import-prefix

/**
 * End-to-end builds through the real graph, cache, and `deno transpile`; only the pinned JSR fixture needs networking.
 *
 * @module
 */

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { exists } from "jsr:@std/fs@1";
import { dirname, join } from "jsr:@std/path@^1";
import { build, type BuildConfig, BuildError } from "../mod.ts";
import { tsToJs, vendoredRel } from "../src/spec.ts";

const NETWORK = Deno.env.get("DTN_INTEGRATION") === "1";

interface BuildResult {
  dir: string;
  error: BuildError | null;
}

async function withBuild(
  files: Record<string, string>,
  config: Omit<BuildConfig, "denoJson" | "root">,
  run: (result: BuildResult) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "dtn-it-" });
  try {
    for (const [relative, content] of Object.entries(files)) {
      const path = join(dir, relative);
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(path, content);
    }
    let error: BuildError | null = null;
    try {
      await build({ ...config, root: dir, denoJson: JSON.parse(files["deno.json"]) });
    } catch (cause) {
      if (!(cause instanceof BuildError)) throw cause;
      error = cause;
    }
    await run({ dir, error });
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("integration — local project emits ESM, declarations, corrected maps, and package metadata", async (t) => {
  const mod =
    `import { helper } from "./util.ts";\nexport function greet(n: number): number {\n  return helper(n);\n}\n`;
  await withBuild(
    {
      "deno.json": JSON.stringify({ name: "@fx/local", version: "1.0.0", exports: "./src/mod.ts" }),
      "src/util.ts": `export function helper(n: number): number {\n  return n * 2;\n}\n`,
      "src/mod.ts": mod,
    },
    { outDir: "dist" },
    async ({ dir, error }) => {
      await t.step("build succeeds and emits every fixed artifact", async () => {
        assertEquals(error, null, error?.message);
        for (const file of ["mod.js", "mod.d.ts", "mod.js.map", "util.js", "util.d.ts", "util.js.map"]) {
          assert(await exists(join(dir, "dist/esm", file)), `missing ${file}`);
        }
      });

      await t.step("the runtime specifier points at JavaScript and declarations remain typed", async () => {
        assertStringIncludes(await Deno.readTextFile(join(dir, "dist/esm/mod.js")), `from "./util.js"`);
        assertStringIncludes(
          await Deno.readTextFile(join(dir, "dist/esm/mod.d.ts")),
          `export declare function greet(n: number): number;`,
        );
      });

      await t.step("the separate map keeps original source provenance and is linked from JavaScript", async () => {
        const js = await Deno.readTextFile(join(dir, "dist/esm/mod.js"));
        assertStringIncludes(js, "//# sourceMappingURL=mod.js.map");
        const map = JSON.parse(await Deno.readTextFile(join(dir, "dist/esm/mod.js.map")));
        assertEquals(map.sources, [`file://${join(dir, "src/mod.ts")}`]);
        assertEquals(map.sourcesContent, [mod]);
      });

      await t.step("package.json exposes runtime and types for the explicit entry", async () => {
        const pkg = JSON.parse(await Deno.readTextFile(join(dir, "dist/package.json")));
        assertEquals(pkg.type, "module");
        assertEquals(pkg.main, "./esm/mod.js");
        assertEquals(pkg.types, "./esm/mod.d.ts");
        assertEquals(pkg.exports, { ".": { types: "./esm/mod.d.ts", default: "./esm/mod.js" } });
      });
    },
  );
});

Deno.test("integration — escaped and query-bearing local specifiers resolve through graph edges", async () => {
  await withBuild(
    {
      "deno.json": JSON.stringify({ name: "@fx/edges", version: "1.0.0", exports: "./src/mod.ts" }),
      "src/util.ts": `export const value = 1;\n`,
      "src/mod.ts": String.raw`import { value } from ".\u002futil.ts?mode=test";` + `\nexport { value };\n`,
    },
    { outDir: "dist" },
    async ({ dir, error }) => {
      assertEquals(error, null, error?.message);
      assertStringIncludes(await Deno.readTextFile(join(dir, "dist/esm/mod.js")), `from "./util.js?mode=test"`);
    },
  );
});

Deno.test("integration — local JavaScript, MJS, and declaration dependencies are copied", async () => {
  await withBuild(
    {
      "deno.json": JSON.stringify({ name: "@fx/copies", version: "1.0.0", exports: "./src/mod.ts" }),
      "src/legacy.js": `export { helper } from "./util.ts";\n`,
      "src/native.mjs": `export const native = 2;\n`,
      "src/types.d.ts": `export interface Config { answer: number }\n`,
      "src/util.ts": `export const helper = 1;\n`,
      "src/mod.ts":
        `import { helper } from "./legacy.js";\nimport { native } from "./native.mjs";\nimport type { Config } from "./types.d.ts";\nexport const value: Config = { answer: helper + native };\n`,
    },
    { outDir: "dist" },
    async ({ dir, error }) => {
      assertEquals(error, null, error?.message);
      assertStringIncludes(await Deno.readTextFile(join(dir, "dist/esm/legacy.js")), `from "./util.js"`);
      assert(await exists(join(dir, "dist/esm/native.mjs")));
      assert(await exists(join(dir, "dist/esm/types.d.ts")));
    },
  );
});

Deno.test("integration — multiple exports, package merge, and copyFiles", async () => {
  await withBuild(
    {
      "deno.json": JSON.stringify({
        name: "@fx/package",
        version: "1.0.0",
        exports: { ".": "./src/mod.ts", "./sub": "./src/sub.ts" },
      }),
      "src/mod.ts": `export const root = 1;\n`,
      "src/sub.ts": `export const sub = 2;\n`,
      "README.md": `# package\n`,
    },
    { outDir: "dist", packageJson: { license: "MIT" }, copyFiles: ["README.md"] },
    async ({ dir, error }) => {
      assertEquals(error, null, error?.message);
      const pkg = JSON.parse(await Deno.readTextFile(join(dir, "dist/package.json")));
      assertEquals(pkg.license, "MIT");
      assertEquals(pkg.exports["./sub"], { types: "./esm/sub.d.ts", default: "./esm/sub.js" });
      assertEquals(await Deno.readTextFile(join(dir, "dist/README.md")), `# package\n`);
    },
  );
});

Deno.test("integration — removed config features fail before replacing prior output", async (t) => {
  for (
    const [name, denoJson] of [
      ["declaration-only export", { name: "@fx/bad", version: "1.0.0", exports: "./src/types.d.ts" }],
      ["wildcard export", { name: "@fx/bad", version: "1.0.0", exports: { "./*": "./src/*.ts" } }],
      [
        "local import-map alias",
        { name: "@fx/bad", version: "1.0.0", exports: "./src/mod.ts", imports: { "$u": "./src/util.ts" } },
      ],
    ] as const
  ) {
    await t.step(name, async () => {
      await withBuild(
        {
          "deno.json": JSON.stringify(denoJson),
          "src/mod.ts": `export const value = 1;\n`,
          "src/types.d.ts": `export interface T {}\n`,
          "dist/SENTINEL": "previous",
        },
        { outDir: "dist" },
        async ({ dir, error }) => {
          assertEquals(error?.code, "INVALID_CONFIG");
          assertEquals(await Deno.readTextFile(join(dir, "dist/SENTINEL")), "previous");
        },
      );
    });
  }
});

Deno.test("integration — removed module media and arbitrary remote origins fail loudly", async (t) => {
  await t.step("local JSON is unsupported", async () => {
    await withBuild(
      {
        "deno.json": JSON.stringify({ name: "@fx/json", version: "1.0.0", exports: "./src/mod.ts" }),
        "src/data.json": `{ "value": 1 }\n`,
        "src/mod.ts": `import data from "./data.json" with { type: "json" };\nexport const value = data.value;\n`,
      },
      { outDir: "dist" },
      ({ error }) => {
        assertEquals(error?.code, "UNSUPPORTED_MODULE");
        return Promise.resolve();
      },
    );
  });

  await t.step("a data URL is outside the JSR graph", async () => {
    await withBuild(
      {
        "deno.json": JSON.stringify({ name: "@fx/remote", version: "1.0.0", exports: "./src/mod.ts" }),
        "src/mod.ts": `import value from "data:text/javascript,export default 1";\nexport { value };\n`,
      },
      { outDir: "dist" },
      ({ error }) => {
        assertEquals(error?.code, "UNSUPPORTED_MODULE");
        return Promise.resolve();
      },
    );
  });
});

Deno.test("integration — build root and compiler options belong to the target project", async () => {
  const dir = await Deno.makeTempDir({ prefix: "dtn-root-" });
  try {
    await Deno.mkdir(join(dir, "project/src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "project/deno.json"),
      JSON.stringify({ compilerOptions: { noUnusedLocals: true } }),
    );
    await Deno.writeTextFile(
      join(dir, "project/src/mod.ts"),
      `export function value(): number {\n  const unused = 1;\n  return 2;\n}\n`,
    );
    let error: BuildError | null = null;
    try {
      await build({
        root: join(dir, "project"),
        outDir: "dist",
        denoJson: { name: "@fx/root", version: "1.0.0", exports: "./src/mod.ts" },
      });
    } catch (cause) {
      if (!(cause instanceof BuildError)) throw cause;
      error = cause;
    }
    assertEquals(error?.code, "EMIT_FAILED");
    assertStringIncludes(error?.message ?? "", "TS6133");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "integration — pinned JSR vendoring and npm externalization",
  ignore: !NETWORK,
  fn: async () => {
    const remote = "https://jsr.io/@std/encoding/1.0.10/hex.ts";
    await withBuild(
      {
        "deno.json": JSON.stringify({
          name: "@fx/jsr",
          version: "1.0.0",
          exports: "./src/mod.ts",
          imports: { hex: "jsr:@std/encoding@1.0.10/hex", chalk: "npm:chalk@^5" },
        }),
        "src/mod.ts":
          `import { encodeHex } from "hex";\nimport chalk from "chalk";\nexport const value = chalk.green(encodeHex(new Uint8Array([1])));\n`,
      },
      { outDir: "dist" },
      async ({ dir, error }) => {
        assertEquals(error, null, error?.message);
        const src = vendoredRel(remote, "_deps", "TypeScript");
        const emit = tsToJs(src);
        assert(await exists(join(dir, "dist/esm", emit)));
        assert(await exists(join(dir, "dist/esm", emit.replace(/\.js$/, ".d.ts"))));
        const js = await Deno.readTextFile(join(dir, "dist/esm/mod.js"));
        assertStringIncludes(js, `from "./${emit}"`);
        assertStringIncludes(js, `from "chalk"`);
        const map = JSON.parse(await Deno.readTextFile(join(dir, "dist/esm", `${emit}.map`)));
        assertEquals(map.sources, [remote]);
        const pkg = JSON.parse(await Deno.readTextFile(join(dir, "dist/package.json")));
        assertEquals(pkg.dependencies, { chalk: "^5" });
      },
    );
  },
});
