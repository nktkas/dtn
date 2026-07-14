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
import { jsToDts, relSpecifier, tsToJs, vendoredRel } from "../src/spec.ts";

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
  const mod = `#!/usr/bin/env -S deno run\nimport { helper } from "./util.ts";\n` +
    `export function greet(n: number): number {\n  return helper(n);\n}\n` +
    'export type Marker = `before\n/// <amd-module name="file:///author/inside" />\nafter`;\n';
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
        assertStringIncludes(declaration, `/// <amd-module name="file:///author/inside" />`);
        assertEquals(declaration.includes(`/// <amd-module name="file://${dir}`), false);
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

Deno.test("integration — option-like source paths remain positional transpile inputs", async () => {
  await withBuild(
    {
      "deno.json": JSON.stringify({ name: "@fx/option-path", version: "1.0.0", exports: "./--entry.ts" }),
      "--entry.ts": `export const value = 51 as const;\n`,
    },
    { outDir: "dist" },
    async ({ dir, error }) => {
      assertEquals(error, null, error?.message);
      for (const file of ["--entry.js", "--entry.d.ts", "--entry.js.map"]) {
        assert(await exists(join(dir, "dist/esm", file)), `missing ${file}`);
      }
      assertEquals(
        await runCommand(
          "node",
          ["--input-type=module", "--eval", `console.log((await import("./dist/esm/--entry.js")).value)`],
          dir,
        ),
        "51",
      );
    },
  );
});

Deno.test("integration — escaped and query-bearing local specifiers resolve through graph edges", async () => {
  await withBuild(
    {
      "deno.json": JSON.stringify({ name: "@fx/edges", version: "1.0.0", exports: "./src/mod.ts" }),
      "src/util.ts": `export const value = 1;\n`,
      "src/mod.ts": String.raw`export { value } from ".\u002futil.ts?mode=test";` + `\n`,
    },
    { outDir: "dist" },
    async ({ dir, error }) => {
      assertEquals(error, null, error?.message);
      assertStringIncludes(await Deno.readTextFile(join(dir, "dist/esm/mod.js")), `from "./util.js?mode=test"`);
      assertStringIncludes(await Deno.readTextFile(join(dir, "dist/esm/mod.d.ts")), `from "./util.js"`);
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

Deno.test("integration — local and remote MTS emit Node ESM artifacts", async () => {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (request) => {
    const source = new URL(request.url).pathname === "/remote.mts"
      ? `export { remote } from "./remote-helper.mts";\n`
      : `export const remote = 62 as const;\n`;
    return new Response(source, {
      headers: { "content-type": "application/typescript" },
    });
  });
  try {
    const remote = `http://127.0.0.1:${server.addr.port}/remote.mts`;
    const remoteHelper = `http://127.0.0.1:${server.addr.port}/remote-helper.mts`;
    await withBuild(
      {
        "deno.json": JSON.stringify({ name: "@fx/mts", version: "1.0.0", exports: "./src/mod.ts" }),
        "src/local-helper.mts": `export const local = 61 as const;\n`,
        "src/local.mts": `export { local } from "./local-helper.mts";\n`,
        "src/mod.ts": `export { local } from "./local.mts";\n` +
          `export { remote } from ${JSON.stringify(remote)};\n`,
      },
      { outDir: "dist" },
      async ({ dir, error }) => {
        assertEquals(error, null, error?.message);
        const remoteEmit = tsToJs(vendoredRel(remote, "_deps", "Mts"));
        const remoteHelperEmit = tsToJs(vendoredRel(remoteHelper, "_deps", "Mts"));
        for (
          const file of [
            "local.mjs",
            "local.d.mts",
            "local.mjs.map",
            "local-helper.mjs",
            "local-helper.d.mts",
            "local-helper.mjs.map",
          ]
        ) {
          assert(await exists(join(dir, "dist/esm", file)), `missing ${file}`);
        }
        for (
          const file of [
            remoteEmit,
            jsToDts(remoteEmit)!,
            `${remoteEmit}.map`,
            remoteHelperEmit,
            jsToDts(remoteHelperEmit)!,
            `${remoteHelperEmit}.map`,
          ]
        ) {
          assert(await exists(join(dir, "dist/esm", file)), `missing ${file}`);
        }
        assertStringIncludes(await Deno.readTextFile(join(dir, "dist/esm/mod.js")), "/mod.mjs");
        for (const file of ["local.mjs", "local.d.mts"]) {
          assertStringIncludes(await Deno.readTextFile(join(dir, "dist/esm", file)), `from "./local-helper.mjs"`);
        }
        const remoteSpecifier = relSpecifier(remoteEmit, remoteHelperEmit);
        for (const file of [remoteEmit, jsToDts(remoteEmit)!]) {
          assertStringIncludes(await Deno.readTextFile(join(dir, "dist/esm", file)), `from "${remoteSpecifier}"`);
        }
        const localMap = JSON.parse(await Deno.readTextFile(join(dir, "dist/esm/local.mjs.map")));
        const remoteMap = JSON.parse(await Deno.readTextFile(join(dir, "dist/esm", `${remoteEmit}.map`)));
        assertEquals(localMap.sources, ["../../src/local.mts"]);
        assertEquals(remoteMap.sources, [remote]);

        const consumer = join(dir, "consumer");
        await installPackage(join(dir, "dist"), consumer, "@fx/mts");
        await Deno.writeTextFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
        await Deno.writeTextFile(
          join(consumer, "runtime.js"),
          `import { local, remote } from "@fx/mts";\nconsole.log([local, remote].join(":"));\n`,
        );
        assertEquals(await runCommand("node", ["runtime.js"], consumer), "61:62");
        await checkNodeNext(
          consumer,
          `import { local, remote } from "@fx/mts";\n` +
            `const localExact: 61 = local;\nconst remoteExact: 62 = remote;\nvoid [localExact, remoteExact];\n`,
        );
      },
    );
  } finally {
    await server.shutdown();
  }
});

Deno.test("integration — HTTP fragments preserve module identity without overriding redirects", async () => {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/redirect.ts") return Response.redirect(new URL("/final.ts", url), 302);
    if (url.pathname === "/data.json") {
      return new Response(`{ "value": 1 }`, { headers: { "content-type": "application/json" } });
    }
    const source = url.pathname === "/helper.ts"
      ? `export const helper = 1;\n`
      : `import { helper } from "./helper.ts";\nexport const token = { helper };\n`;
    return new Response(source, {
      headers: { "content-type": "application/typescript" },
    });
  });
  try {
    const base = `http://127.0.0.1:${server.addr.port}`;
    const directPlain = `${base}/direct.ts`;
    const directEmptyQuery = `${base}/direct.ts?`;
    const directEmpty = `${base}/direct.ts#`;
    const directA = `${base}/direct.ts#a`;
    const directEmptyQueryA = `${base}/direct.ts?#a`;
    const directB = `${base}/direct.ts#b`;
    const redirectA = `${base}/redirect.ts#a`;
    const redirectB = `${base}/redirect.ts#b`;
    const jsonA = `${base}/data.json#a`;
    const jsonB = `${base}/data.json#b`;
    await withBuild(
      {
        "deno.json": JSON.stringify({ name: "@fx/fragments", version: "1.0.0", exports: "./src/mod.ts" }),
        "src/mod.ts": `import { token as directPlain } from ${JSON.stringify(directPlain)};\n` +
          `import { token as directEmptyQuery } from ${JSON.stringify(directEmptyQuery)};\n` +
          `import { token as directEmpty } from ${JSON.stringify(directEmpty)};\n` +
          `import { token as directA } from ${JSON.stringify(directA)};\n` +
          `import { token as directEmptyQueryA } from ${JSON.stringify(directEmptyQueryA)};\n` +
          `import { token as directB } from ${JSON.stringify(directB)};\n` +
          `import { token as redirectA } from ${JSON.stringify(redirectA)};\n` +
          `import { token as redirectB } from ${JSON.stringify(redirectB)};\n` +
          `import jsonA from ${JSON.stringify(jsonA)} with { type: "json" };\n` +
          `import jsonB from ${JSON.stringify(jsonB)} with { type: "json" };\n` +
          `export const directDistinct = ` +
          `new Set([directPlain, directEmptyQuery, directEmpty, directA, directEmptyQueryA, directB]).size === 6;\n` +
          `export const jsonDistinct = jsonA !== jsonB;\n` +
          `export const redirectSame = redirectA === redirectB;\n`,
      },
      { outDir: "dist" },
      async ({ dir, error }) => {
        assertEquals(error, null, error?.message);
        for (const remote of [directPlain, directEmptyQuery, directEmpty, directA, directEmptyQueryA, directB]) {
          const emit = tsToJs(vendoredRel(remote, "_deps", "TypeScript"));
          const map = JSON.parse(await Deno.readTextFile(join(dir, "dist/esm", `${emit}.map`)));
          assertEquals(map.sources, [remote]);
        }
        assertEquals(
          await runCommand(
            "node",
            [
              "--input-type=module",
              "--eval",
              `const result = await import("./dist/esm/mod.js"); ` +
              `console.log([result.directDistinct, result.jsonDistinct, result.redirectSame].join(":"));`,
            ],
            dir,
          ),
          "true:true:true",
        );
      },
    );
  } finally {
    await server.shutdown();
  }
});

Deno.test("integration — local JavaScript, MJS, and declaration dependencies are copied", async () => {
  await withBuild(
    {
      "deno.json": JSON.stringify({ name: "@fx/copies", version: "1.0.0", exports: "./src/mod.ts" }),
      "src/legacy.js": `export { helper } from "./util.ts";\n//# sourceMappingURL=legacy.js.map\n`,
      "src/native.mjs": `export const native = 2;\n`,
      "src/legacy.d.ts": `import type { Details } from "./types.ts";\n` +
        `export interface Config { answer: number; details?: Details }\n`,
      "src/types.ts": `export interface Details { label: string }\n`,
      "src/util.ts": `export const helper = 1;\n`,
      "src/mod.ts": `import { helper } from "./legacy.js";\n` +
        `import { native } from "./native.mjs";\n` +
        `import type { Config } from "./legacy.d.ts";\n` +
        `export const value: Config = { answer: helper + native };\n`,
    },
    { outDir: "dist" },
    async ({ dir, error }) => {
      assertEquals(error, null, error?.message);
      const legacy = await Deno.readTextFile(join(dir, "dist/esm/legacy.js"));
      assertStringIncludes(legacy, `from "./util.js"`);
      assertEquals(legacy.includes("sourceMappingURL"), false);
      assert(await exists(join(dir, "dist/esm/native.mjs")));
      assertStringIncludes(await Deno.readTextFile(join(dir, "dist/esm/legacy.d.ts")), `from "./types.js"`);
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
    const remoteTs = "data:text/typescript,export%20const%20remoteHelper%20%3D%205%20as%20const%3B";
    const remote = `data:application/javascript,${
      encodeURIComponent(
        `#!/usr/bin/env node\nexport { remoteHelper } from "${remoteTs}";\nexport const remote = 4;\n`,
      )
    }`;
    await withBuild(
      {
        "deno.json": JSON.stringify({
          name: "@fx/consumer",
          version: "1.0.0",
          exports: { ".": "./src/mod.ts", "./sub": "./src/sub.ts" },
        }),
        "src/mod.ts": `export const root = 1 as const;\n` +
          `export { double, helper } from "./value.js?mode=js";\n` +
          `export { mjsHelper, upper } from "./native.mjs?mode=mjs";\n` +
          `export type { CJS } from "./types.d.cts";\n` +
          `export type { ESM } from "./types.d.mts";\n` +
          `export { remote, remoteHelper } from "${remote}";\n`,
        "src/sub.ts": `export function sub(value: number): string {\n  return String(value);\n}\n`,
        "src/value.js": `export { helper } from "./helper.ts";\n` +
          `/** @param {number} value */\nexport function double(value) { return value * 2; }\n`,
        "src/helper.ts": `export const helper = 8 as const;\n`,
        "src/mjs-helper.ts": `export const mjsHelper = 9 as const;\n`,
        "src/native.mjs": `export { mjsHelper } from "./mjs-helper.ts";\n` +
          `/** @param {string} value */\nexport function upper(value) { return value.toUpperCase(); }\n`,
        "src/type-helper.ts": `export interface Details { readonly label: string }\n`,
        "src/types.d.cts": `import type { Details } from "./type-helper.ts";\n` +
          `export interface CJS { readonly details: Details; readonly kind: "cjs" }\n`,
        "src/types.d.mts": `import type { Details } from "./type-helper.ts";\n` +
          `export interface ESM { readonly details: Details; readonly kind: "esm" }\n`,
      },
      { outDir: "dist" },
      async ({ dir, error }) => {
        assertEquals(error, null, error?.message);
        assertEquals((await Deno.readTextFile(join(dir, "dist/esm/value.d.ts"))).includes("amd-module"), false);
        assertEquals((await Deno.readTextFile(join(dir, "dist/esm/native.d.mts"))).includes("amd-module"), false);
        const consumer = join(dir, "consumer");
        await installPackage(join(dir, "dist"), consumer, "@fx/consumer");
        await Deno.writeTextFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));

        await t.step("Node resolves and executes both package exports", async () => {
          await Deno.writeTextFile(
            join(consumer, "runtime.js"),
            `import { double, helper, mjsHelper, remote, remoteHelper, root, upper } from "@fx/consumer";\n` +
              `import { sub } from "@fx/consumer/sub";\n` +
              `console.log([root, sub(2), double(3), upper("ok"), remote, helper, mjsHelper, remoteHelper].join(":"));\n`,
          );
          assertEquals(await runCommand("node", ["runtime.js"], consumer), "1:2:6:OK:4:8:9:5");
        });

        await t.step("TypeScript resolves both declaration exports with NodeNext", async () => {
          await checkNodeNext(
            consumer,
            `import { double, helper, mjsHelper, remote, remoteHelper, root, upper } from "@fx/consumer";\n` +
              `import type { CJS, ESM } from "@fx/consumer";\n` +
              `import { sub } from "@fx/consumer/sub";\n` +
              `const cjs: CJS = { details: { label: "cjs" }, kind: "cjs" };\n` +
              `const esm: ESM = { details: { label: "esm" }, kind: "esm" };\n` +
              `const exact: 1 = root;\n` +
              `const text: string = sub(exact);\n` +
              `const doubled: number = double(2);\n` +
              `const uppered: string = upper(text);\n` +
              `const remoteExact: 4 = remote;\n` +
              `const helperExact: 8 = helper;\n` +
              `const mjsHelperExact: 9 = mjsHelper;\n` +
              `const remoteHelperExact: 5 = remoteHelper;\n` +
              `void [cjs, doubled, esm, helperExact, mjsHelperExact, remoteExact, remoteHelperExact, uppered];\n`,
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
          imports: { schema: "npm:zod@4.2.1" },
        }),
        "src/mod.ts": `import { z } from "schema/v4";\n` +
          `declare module "schema/v4" { interface ZodType { readonly probeMarker?: true } }\n` +
          `export const schema = z.literal("typed");\n`,
      },
      { outDir: "dist" },
      async ({ dir, error }) => {
        assertEquals(error, null, error?.message);
        const declaration = await Deno.readTextFile(join(dir, "dist/esm/mod.d.ts"));
        assertStringIncludes(declaration, `import { z } from "zod/v4";`);
        assertStringIncludes(declaration, `declare module "zod/v4"`);
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

Deno.test("integration — local and remote JSON dependencies are copied and execute in Node", async () => {
  const localJson = `{ "value": 1 }\n`;
  const remoteJson = `\uFEFF{ "value": 2 }\r\n`;
  const remote = `data:application/json,${encodeURIComponent(remoteJson)}`;
  const remoteSource = `import data from "${remote}" with { type: "json" };\nexport const nested = data.value;\n`;
  const remoteTs = `data:text/typescript,${encodeURIComponent(remoteSource)}`;
  await withBuild(
    {
      "deno.json": JSON.stringify({ name: "@fx/json", version: "1.0.0", exports: "./src/mod.ts" }),
      "src/data.json": localJson,
      "src/mod.ts": `import local from "./data.json" with { type: "json" };\n` +
        `import remote from "${remote}" with { type: "json" };\n` +
        `import { nested } from "${remoteTs}";\n` +
        `export const value = local.value + remote.value + nested;\n` +
        `export { default as localRaw } from "./data.json" with { type: "json" };\n` +
        `export { default as remoteRaw } from "${remote}" with { type: "json" };\n`,
    },
    { outDir: "dist" },
    async ({ dir, error }) => {
      assertEquals(error, null, error?.message);
      assertEquals(await Deno.readTextFile(join(dir, "dist/esm/data.json")), localJson);
      const runtime = await Deno.readTextFile(join(dir, "dist/esm/mod.js"));
      const remotePath = runtime.match(/from "(\.\/.+\/mod\.json)"/)?.[1];
      assert(remotePath !== undefined);
      assertEquals(await Deno.readFile(join(dir, "dist/esm", remotePath)), new TextEncoder().encode(remoteJson));
      const declaration = await Deno.readTextFile(join(dir, "dist/esm/mod.d.ts"));
      assertStringIncludes(declaration, `export { default as remoteRaw } from "${remotePath}";`);
      assertEquals(
        await runCommand(
          "node",
          [
            "--input-type=module",
            "--eval",
            `const { localRaw, remoteRaw, value } = await import("./dist/esm/mod.js"); ` +
            `console.log(value + localRaw.value + remoteRaw.value);`,
          ],
          dir,
        ),
        "8",
      );
    },
  );
});

Deno.test("integration — arbitrary remote modules are vendored and execute in Node", async () => {
  const remote = "data:text/typescript,export%20default%201%20as%20const";
  await withBuild(
    {
      "deno.json": JSON.stringify({ name: "@fx/remote", version: "1.0.0", exports: "./src/mod.ts" }),
      "src/mod.ts": `import value from "${remote}";\nexport { value };\n`,
    },
    { outDir: "dist" },
    async ({ dir, error }) => {
      assertEquals(error, null, error?.message);
      const emit = tsToJs(vendoredRel(remote, "_deps", "TypeScript"));
      assert(await exists(join(dir, "dist/esm", emit)));
      assertEquals(
        await runCommand(
          "node",
          ["--input-type=module", "--eval", `console.log((await import("./dist/esm/mod.js")).value)`],
          dir,
        ),
        "1",
      );
    },
  );
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
