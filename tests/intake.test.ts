// deno-lint-ignore-file no-import-prefix

/**
 * Unit tests for `intake`: config validation and its normalization into a `Plan`.
 *
 * @module
 */

import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { BuildError } from "../src/errors.ts";
import { type BuildConfig, intake } from "../src/intake.ts";

const REPO = "/repo";

function cfg(
  denoJson: Partial<BuildConfig["denoJson"]> = {},
  rest: Omit<Partial<BuildConfig>, "deno"> = {},
): BuildConfig {
  return {
    outDir: "dist",
    denoJson: { name: "@x/lib", version: "1.0.0", exports: "./src/mod.ts", ...denoJson },
    ...rest,
  };
}

function throwsWithCode(fn: () => unknown, code: string): void {
  const e = assertThrows(fn, BuildError);
  assertEquals((e as BuildError).code, code);
}

Deno.test("intake — valid input produces a Plan", async (t) => {
  await t.step("string exports normalize to a '.' entry, paths resolve, defaults fill in", () => {
    assertEquals(intake(cfg(), REPO), {
      repoRoot: "/repo",
      outDir: "/repo/dist",
      codeDir: "/repo/dist/esm",
      tmpDir: "/repo/dist/.dts-tmp",
      name: "@x/lib",
      version: "1.0.0",
      exports: { ".": "./src/mod.ts" },
      imports: {},
      npmReplacements: {},
      packageJson: {},
      copyFiles: [],
      sourceMap: "separate",
      depsDir: "_deps",
    });
  });

  await t.step("map exports are kept as-is", () => {
    const plan = intake(cfg({ exports: { ".": "./src/mod.ts", "./sub": "./src/sub.ts" } }), REPO);
    assertEquals(plan.exports, { ".": "./src/mod.ts", "./sub": "./src/sub.ts" });
  });

  await t.step("a .d.ts entry point is accepted", () => {
    const plan = intake(cfg({ exports: { ".": "./src/types.d.ts" } }), REPO);
    assertEquals(plan.exports, { ".": "./src/types.d.ts" });
  });

  await t.step("imports, packageJson, copyFiles pass through", () => {
    const plan = intake(
      cfg({ imports: { chalk: "npm:chalk@^5" } }, { packageJson: { license: "MIT" }, copyFiles: ["README.md"] }),
      REPO,
    );
    assertEquals(plan.imports, { chalk: "npm:chalk@^5" });
    assertEquals(plan.packageJson, { license: "MIT" });
    assertEquals(plan.copyFiles, ["README.md"]);
  });

  await t.step("a valid npmReplacements alias (jsr or npm target) is accepted", () => {
    const plan = intake(
      cfg(
        { imports: { "@valibot/valibot": "jsr:@valibot/valibot@1", chalk: "npm:chalk@^5" } },
        { npmReplacements: { "@valibot/valibot": "valibot", chalk: "chalk" } },
      ),
      REPO,
    );
    assertEquals(plan.npmReplacements, { "@valibot/valibot": "valibot", chalk: "chalk" });
  });
});

Deno.test("intake — contract violations throw the documented BuildError", async (t) => {
  await t.step("INVALID_EXPORTS: empty exports map", () => {
    throwsWithCode(() => intake(cfg({ exports: {} }), REPO), "INVALID_EXPORTS");
  });

  await t.step("INVALID_EXPORTS: empty-string entry", () => {
    throwsWithCode(() => intake(cfg({ exports: { ".": "" } }), REPO), "INVALID_EXPORTS");
  });

  await t.step("INVALID_EXPORTS: a non-.ts entry point (.js)", () => {
    throwsWithCode(() => intake(cfg({ exports: { ".": "./src/mod.js" } }), REPO), "INVALID_EXPORTS");
  });

  await t.step("INVALID_EXPORTS: a non-.ts entry point (.json)", () => {
    throwsWithCode(() => intake(cfg({ exports: { ".": "./data.json" } }), REPO), "INVALID_EXPORTS");
  });

  await t.step("INVALID_EXPORTS: an entry that only contains '.ts' as a non-suffix substring", () => {
    // The check is endsWith('.ts'), not includes('.ts'): a path where '.ts' is not the extension is rejected.
    throwsWithCode(() => intake(cfg({ exports: { ".": "./src/mod.ts.js" } }), REPO), "INVALID_EXPORTS");
    throwsWithCode(() => intake(cfg({ exports: { ".": "./src/a.tsx" } }), REPO), "INVALID_EXPORTS");
  });

  await t.step("REPLACEMENT_ALIAS_UNKNOWN: alias absent from the import map", () => {
    throwsWithCode(
      () => intake(cfg({ imports: {} }, { npmReplacements: { "@v/v": "valibot" } }), REPO),
      "REPLACEMENT_ALIAS_UNKNOWN",
    );
  });

  await t.step("REPLACEMENT_TARGET_INVALID: alias maps to neither jsr nor npm", () => {
    throwsWithCode(
      () => intake(cfg({ imports: { x: "https://example.com/x.ts" } }, { npmReplacements: { x: "ex" } }), REPO),
      "REPLACEMENT_TARGET_INVALID",
    );
  });
});
