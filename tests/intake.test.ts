// deno-lint-ignore-file no-import-prefix

/**
 * Unit tests for build-config validation and normalization.
 *
 * @module
 */

import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { join, resolve } from "@std/path";
import { BuildError } from "../src/errors.ts";
import { type BuildConfig, intake } from "../src/intake.ts";

const REPO = resolve("repo");

function config(
  denoJson: Partial<BuildConfig["denoJson"]> = {},
  rest: Omit<Partial<BuildConfig>, "denoJson"> = {},
): BuildConfig {
  return {
    outDir: "dist",
    denoJson: { name: "@x/lib", version: "1.0.0", exports: "./src/mod.ts", ...denoJson },
    ...rest,
  };
}

function invalid(config: BuildConfig): BuildError {
  const error = assertThrows(() => intake(config, REPO), BuildError);
  assertEquals(error.code, "INVALID_CONFIG");
  return error;
}

Deno.test("intake — valid config", async (t) => {
  await t.step("normalizes paths, exports, and defaults", () => {
    assertEquals(intake(config(), REPO), {
      repoRoot: REPO,
      outDir: join(REPO, "dist"),
      codeDir: join(REPO, "dist", "esm"),
      tmpDir: join(REPO, "dist", ".dts-tmp"),
      name: "@x/lib",
      version: "1.0.0",
      exports: { ".": "./src/mod.ts" },
      imports: {},
      npmReplacements: {},
      packageJson: {},
      copyFiles: [],
      depsDir: "_deps",
    });
  });

  await t.step("keeps explicit exports and registry aliases", () => {
    const plan = intake(
      config({
        exports: { ".": "./src/mod.ts", "./sub": "./src/sub.ts" },
        imports: { "@std/encoding": "jsr:@std/encoding@^1", chalk: "npm:chalk@^5" },
      }),
      REPO,
    );
    assertEquals(plan.exports, { ".": "./src/mod.ts", "./sub": "./src/sub.ts" });
    assertEquals(plan.imports, { "@std/encoding": "jsr:@std/encoding@^1", chalk: "npm:chalk@^5" });
  });

  await t.step("keeps merge metadata, copied files, and a custom vendor directory", () => {
    const plan = intake(
      config({}, { packageJson: { license: "MIT" }, copyFiles: ["README.md"], depsDir: "vendor" }),
      REPO,
    );
    assertEquals(plan.packageJson, { license: "MIT" });
    assertEquals(plan.copyFiles, ["README.md"]);
    assertEquals(plan.depsDir, "vendor");
  });
});

Deno.test("intake — invalid config", async (t) => {
  await t.step("rejects exports outside the explicit runtime .ts contract", () => {
    const invalidExports: Array<Record<string, string>> = [
      {},
      { ".": "" },
      { ".": "./src/types.d.ts" },
      { "./*": "./src/*.ts" },
      { sub: "./src/sub.ts" },
      { ".": "./src/mod.js" },
      { ".": "./src/mod.mts" },
      { ".": "./src/mod.tsx" },
    ];
    for (const exports of invalidExports) {
      invalid(config({ exports }));
    }
  });

  await t.step("rejects local and hosted import-map targets", () => {
    invalid(config({ imports: { "$util": "./src/util.ts" } }));
    invalid(config({ imports: { remote: "https://example.com/mod.ts" } }));
  });

  await t.step("rejects a mismatched prefix mapping", () => {
    invalid(config({ imports: { "@scope/": "jsr:@scope/pkg@1" } }));
  });

  await t.step("rejects an unknown replacement alias and malformed package name", () => {
    invalid(config({ imports: {} }, { npmReplacements: { x: "pkg" } }));
    invalid(config({ imports: { x: "jsr:@scope/pkg@1" } }, { npmReplacements: { x: "" } }));
  });
});
