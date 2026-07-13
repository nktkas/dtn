// deno-lint-ignore-file no-import-prefix

/**
 * End-to-end builds through the real graph, cache, and `deno transpile`.
 * Networked registry and consumer checks require `DTN_INTEGRATION=1`.
 *
 * @module
 */

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { copy, exists } from "jsr:@std/fs@1";
import { dirname, join } from "jsr:@std/path@^1";
import { build, type BuildConfig, BuildError } from "../mod.ts";
import { tsToJs, vendoredRel } from "../src/spec.ts";

const NETWORK = Deno.env.get("DTN_INTEGRATION") === "1";
const NPM_COMMAND = Deno.build.os === "windows" ? "npm.cmd" : "npm";

/** The temporary project and captured domain failure supplied to a build assertion. */
interface BuildResult {
  dir: string;
  error: BuildError | null;
}

/** Builds one temporary project and removes it after its assertions finish. */
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

/** Copies a generated package into a consumer's `node_modules` tree. */
async function installPackage(source: string, consumer: string, name: string): Promise<void> {
  const target = join(consumer, "node_modules", ...name.split("/"));
  await Deno.mkdir(dirname(target), { recursive: true });
  await copy(source, target, { overwrite: true });
}

/** Runs a consumer command and returns stdout, failing with the captured diagnostics. */
async function runCommand(command: string, args: string[], cwd: string): Promise<string> {
  const { code, stdout, stderr } = await new Deno.Command(command, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  if (code !== 0) {
    throw new Error(
      [decoder.decode(stdout), decoder.decode(stderr), `(${command} ${args.join(" ")} exited with ${code})`]
        .filter((part) => part.length > 0)
        .join("\n"),
    );
  }
  return decoder.decode(stdout).trim();
}

/** Type-checks one ESM consumer with TypeScript's NodeNext package resolution. */
async function checkNodeNext(consumer: string, source: string): Promise<void> {
  await Deno.writeTextFile(join(consumer, "consumer.ts"), source);
  await Deno.writeTextFile(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2022",
        strict: true,
        noEmit: true,
      },
      include: ["consumer.ts"],
    }),
  );
  await runCommand(
    Deno.execPath(),
    ["run", "-A", "npm:typescript@5.9.3/bin/tsc", "--project", "tsconfig.json"],
    consumer,
  );
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
        const declaration = await Deno.readTextFile(join(dir, "dist/esm/mod.d.ts"));
        assertStringIncludes(declaration, `export declare function greet(n: number): number;`);
        assertEquals(declaration.includes(`/// <amd-module name="file:///`), false);
      });

      await t.step("the separate map keeps original source provenance and is linked from JavaScript", async () => {
        const js = await Deno.readTextFile(join(dir, "dist/esm/mod.js"));
        assertStringIncludes(js, "//# sourceMappingURL=mod.js.map");
        const map = JSON.parse(await Deno.readTextFile(join(dir, "dist/esm/mod.js.map")));
        assertEquals(map.sources, ["../../src/mod.ts"]);
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

Deno.test("integration — string-literal runtime imports execute in Node", async () => {
  await withBuild(
    {
      "deno.json": JSON.stringify({ name: "@fx/dynamic", version: "1.0.0", exports: "./src/mod.ts" }),
      "src/feature.ts": `export const value = 42;\n`,
      "src/mod.ts": `export async function load(): Promise<number> {\n` +
        `  return (await import("./feature.ts")).value;\n` +
        `}\n`,
    },
    { outDir: "dist" },
    async ({ dir, error }) => {
      assertEquals(error, null, error?.message);
      assertStringIncludes(await Deno.readTextFile(join(dir, "dist/esm/mod.js")), `import("./feature.js")`);
      assertEquals(
        await runCommand(
          "node",
          ["--input-type=module", "--eval", `console.log(await (await import("./dist/esm/mod.js")).load())`],
          dir,
        ),
        "42",
      );
    },
  );
});

Deno.test("integration — local JavaScript, MJS, and declaration dependencies are copied", async () => {
  await withBuild(
    {
      "deno.json": JSON.stringify({ name: "@fx/copies", version: "1.0.0", exports: "./src/mod.ts" }),
      "src/legacy.js": `export { helper } from "./util.ts";\n//# sourceMappingURL=legacy.js.map\n`,
      "src/native.mjs": `export const native = 2;\n`,
      "src/types.d.ts": `export interface Config { answer: number }\n`,
      "src/util.ts": `export const helper = 1;\n`,
      "src/mod.ts": `import { helper } from "./legacy.js";\n` +
        `import { native } from "./native.mjs";\n` +
        `import type { Config } from "./types.d.ts";\n` +
        `export const value: Config = { answer: helper + native };\n`,
    },
    { outDir: "dist" },
    async ({ dir, error }) => {
      assertEquals(error, null, error?.message);
      const legacy = await Deno.readTextFile(join(dir, "dist/esm/legacy.js"));
      assertStringIncludes(legacy, `from "./util.js"`);
      assertEquals(legacy.includes("sourceMappingURL"), false);
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

Deno.test({
  name: "integration — generated root and subpath exports work in Node and TypeScript NodeNext",
  ignore: !NETWORK,
  fn: async (t) => {
    await withBuild(
      {
        "deno.json": JSON.stringify({
          name: "@fx/consumer",
          version: "1.0.0",
          exports: { ".": "./src/mod.ts", "./sub": "./src/sub.ts" },
        }),
        "src/mod.ts": `export const root = 1 as const;\n`,
        "src/sub.ts": `export function sub(value: number): string {\n  return String(value);\n}\n`,
      },
      { outDir: "dist" },
      async ({ dir, error }) => {
        assertEquals(error, null, error?.message);
        const consumer = join(dir, "consumer");
        await installPackage(join(dir, "dist"), consumer, "@fx/consumer");
        await Deno.writeTextFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));

        await t.step("Node resolves and executes both package exports", async () => {
          await Deno.writeTextFile(
            join(consumer, "runtime.js"),
            `import { root } from "@fx/consumer";\nimport { sub } from "@fx/consumer/sub";\nconsole.log(root + ":" + sub(2));\n`,
          );
          assertEquals(await runCommand("node", ["runtime.js"], consumer), "1:2");
        });

        await t.step("TypeScript resolves both declaration exports with NodeNext", async () => {
          await checkNodeNext(
            consumer,
            `import { root } from "@fx/consumer";\n` +
              `import { sub } from "@fx/consumer/sub";\n` +
              `const exact: 1 = root;\n` +
              `const text: string = sub(exact);\n` +
              `void text;\n`,
          );
        });
      },
    );
  },
});

Deno.test({
  name: "integration — npm replacement survives build, package metadata, and Node consumption",
  ignore: !NETWORK,
  fn: async () => {
    await withBuild(
      {
        "deno.json": JSON.stringify({
          name: "@fx/replacement",
          version: "1.0.0",
          exports: "./src/mod.ts",
          imports: { "@valibot/valibot": "jsr:@valibot/valibot@1" },
        }),
        "src/mod.ts": `import * as v from "@valibot/valibot";\nexport const value = v.literal("replacement-ok");\n`,
      },
      { outDir: "dist", npmReplacements: { "@valibot/valibot": "valibot@^1" } },
      async ({ dir, error }) => {
        assertEquals(error, null, error?.message);
        assertStringIncludes(await Deno.readTextFile(join(dir, "dist/esm/mod.js")), `from "valibot"`);
        assertStringIncludes(await Deno.readTextFile(join(dir, "dist/esm/mod.d.ts")), `from "valibot"`);
        const pkg = JSON.parse(await Deno.readTextFile(join(dir, "dist/package.json")));
        assertEquals(pkg.dependencies, { valibot: "^1" });

        const consumer = join(dir, "consumer");
        await Deno.mkdir(consumer, { recursive: true });
        await Deno.writeTextFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
        const packed = JSON.parse(
          await runCommand(
            NPM_COMMAND,
            ["pack", join(dir, "dist"), "--pack-destination", consumer, "--json"],
            consumer,
          ),
        );
        await runCommand(
          NPM_COMMAND,
          ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(consumer, packed[0].filename)],
          consumer,
        );

        await Deno.writeTextFile(
          join(consumer, "runtime.js"),
          `import { value } from "@fx/replacement";\nconsole.log(value.literal);\n`,
        );
        assertEquals(await runCommand("node", ["runtime.js"], consumer), "replacement-ok");

        await checkNodeNext(
          consumer,
          `import { value } from "@fx/replacement";\nconst literal: "replacement-ok" = value.literal;\nvoid literal;\n`,
        );
      },
    );
  },
});

Deno.test({
  name: "integration — npm alias subpaths preserve declaration types",
  ignore: !NETWORK,
  fn: async () => {
    await withBuild(
      {
        "deno.json": JSON.stringify({
          name: "@fx/npm-subpath",
          version: "1.0.0",
          exports: "./src/mod.ts",
          imports: { zod: "npm:zod@4.2.1" },
        }),
        "src/mod.ts": `import { z } from "zod/v4";\nexport const schema = z.literal("typed");\n`,
      },
      { outDir: "dist" },
      async ({ dir, error }) => {
        assertEquals(error, null, error?.message);
        const declaration = await Deno.readTextFile(join(dir, "dist/esm/mod.d.ts"));
        assertStringIncludes(declaration, `import { z } from "zod/v4";`);
        assertStringIncludes(declaration, `schema: z.ZodLiteral<"typed">`);
      },
    );
  },
});

Deno.test("integration — unsupported config features fail before replacing prior output", async (t) => {
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

Deno.test("integration — unsupported module media and arbitrary remote origins fail loudly", async (t) => {
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
        "src/mod.ts": `import { encodeHex } from "hex";\n` +
          `import chalk from "chalk";\n` +
          `export const value = chalk.green(encodeHex(new Uint8Array([1])));\n`,
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
