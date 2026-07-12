// deno-lint-ignore-file no-import-prefix

/**
 * Unit tests for declaration import maps and replacement conflicts.
 *
 * @module
 */

import { assertEquals } from "jsr:@std/assert@1";
import { SpecifierIndex } from "../src/analyze.ts";

const LOCAL = "file:///repo/src/mod.ts";

function index(): SpecifierIndex {
  return new SpecifierIndex({
    edges: new Map([
      [
        LOCAL,
        new Map([["@scope/a", { kind: "vendored" as const, src: "vendor/a/mod.ts", emit: "vendor/a/mod.js" }]]),
      ],
    ]),
    aliases: [{ alias: "chalk", npmName: "chalk", subpath: "", version: "^5" }],
    replacedJsrPackages: new Map([["@valibot/valibot", "valibot"]]),
    npmDeps: { chalk: "^5" },
  });
}

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
