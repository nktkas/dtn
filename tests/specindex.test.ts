// deno-lint-ignore-file no-import-prefix

/**
 * Unit tests for referrer-specific specifier bindings and declaration import maps.
 *
 * @module
 */

import { assertEquals } from "jsr:@std/assert@1";
import { SpecifierIndex } from "../src/analyze.ts";

const LOCAL = "file:///repo/src/mod.ts";
const REMOTE_A = "https://jsr.io/@scope/a/1/mod.ts";
const REMOTE_B = "https://jsr.io/@scope/b/1/mod.ts";

function index(): SpecifierIndex {
  return new SpecifierIndex({
    edges: new Map([
      [
        LOCAL,
        new Map([
          ["@scope/a", { kind: "vendored" as const, src: "vendor/a/mod.ts", emit: "vendor/a/mod.js" }],
          ["chalk", { kind: "npm" as const, bare: "chalk" }],
          ["./util.ts?mode=x", { kind: "local" as const, emit: "util.js", suffix: "?mode=x" }],
        ]),
      ],
      [
        REMOTE_A,
        new Map([["./shared.ts", {
          kind: "vendored" as const,
          src: "vendor/a/shared/mod.ts",
          emit: "vendor/a/shared/mod.js",
        }]]),
      ],
      [
        REMOTE_B,
        new Map([["./shared.ts", {
          kind: "vendored" as const,
          src: "vendor/b/shared/mod.ts",
          emit: "vendor/b/shared/mod.js",
        }]]),
      ],
    ]),
    aliases: [{ alias: "chalk", npmName: "chalk", subpath: "", version: "^5" }],
    replacedJsrPackages: new Map([["@valibot/valibot", "valibot"]]),
    npmDeps: { chalk: "^5" },
  });
}

Deno.test("SpecifierIndex.resolve — the same text resolves by referrer", () => {
  const specifiers = index();
  assertEquals(specifiers.resolve(REMOTE_A, "./shared.ts"), {
    kind: "vendored",
    src: "vendor/a/shared/mod.ts",
    emit: "vendor/a/shared/mod.js",
  });
  assertEquals(specifiers.resolve(REMOTE_B, "./shared.ts"), {
    kind: "vendored",
    src: "vendor/b/shared/mod.ts",
    emit: "vendor/b/shared/mod.js",
  });
  assertEquals(specifiers.resolve(LOCAL, "./shared.ts"), null);
});

Deno.test("SpecifierIndex.resolve — local query identity and npm target", () => {
  assertEquals(index().resolve(LOCAL, "./util.ts?mode=x"), {
    kind: "local",
    emit: "util.js",
    suffix: "?mode=x",
  });
  assertEquals(index().resolve(LOCAL, "chalk"), { kind: "npm", bare: "chalk" });
});

Deno.test("SpecifierIndex import maps", () => {
  assertEquals(index().declarationImportMap(), {
    chalk: "npm:chalk@^5",
    "@scope/a": "./vendor/a/mod.ts",
  });
  assertEquals(index().vendorImportMap(), { chalk: "npm:chalk@^5" });
});

Deno.test("SpecifierIndex.replacedJsrConflict", () => {
  assertEquals(index().replacedJsrConflict("jsr:@valibot/valibot@1/schema"), "valibot");
  assertEquals(index().replacedJsrConflict("jsr:@scope/a@1"), null);
});
