// deno-lint-ignore-file no-import-prefix

/**
 * Unit tests for declaration import maps.
 *
 * @module
 */

import { assertEquals } from "jsr:@std/assert@1";
import { SpecifierIndex } from "../src/analyze.ts";

const LOCAL = "file:///repo/src/mod.ts";
const REMOTE = "https://jsr.io/@scope/a/1/mod.ts";

function index(): SpecifierIndex {
  return new SpecifierIndex({
    edges: new Map([
      [
        LOCAL,
        new Map([
          ["@scope/a", { kind: "vendored" as const, src: "vendor/a/mod.ts", emit: "vendor/a/mod.js" }],
          ["zod/v4", { kind: "npm" as const, bare: "zod/v4", registry: "npm:zod@4.2.1/v4" }],
          ["foo", { kind: "npm" as const, bare: "bar", registry: "npm:bar@1" }],
        ]),
      ],
      [
        REMOTE,
        new Map([
          ["npm:zod@4.2.1/v4", { kind: "npm" as const, bare: "zod/v4", registry: "npm:zod@4.2.1/v4" }],
          [
            "npm:date-fns@4.1.0/addDays",
            { kind: "npm" as const, bare: "date-fns/addDays", registry: "npm:date-fns@4.1.0/addDays" },
          ],
          ["npm:foo@2", { kind: "npm" as const, bare: "foo", registry: "npm:foo@2" }],
        ]),
      ],
    ]),
    aliases: [
      { alias: "chalk", npmName: "chalk", subpath: "", version: "^5" },
      { alias: "zod", npmName: "zod", subpath: "", version: "4.2.1" },
      { alias: "foo", npmName: "bar", subpath: "", version: "1" },
    ],
    vendorSources: new Map([[REMOTE, "vendor/a/mod.ts"]]),
    npmDeps: { chalk: "^5", zod: "4.2.1", "date-fns": "4.1.0", bar: "1", foo: "2" },
  });
}

Deno.test("SpecifierIndex import maps", () => {
  assertEquals(index().declarationImportMap(), {
    imports: {
      chalk: "npm:chalk@^5",
      zod: "npm:zod@4.2.1",
      "zod/v4": "npm:zod@4.2.1/v4",
      foo: "npm:bar@1",
      "@scope/a": "./vendor/a/mod.ts",
    },
    scopes: {
      "./vendor/a/mod.ts": {
        "zod/v4": "npm:zod@4.2.1/v4",
        "date-fns/addDays": "npm:date-fns@4.1.0/addDays",
        foo: "npm:foo@2",
      },
    },
  });
  assertEquals(index().vendorImportMap(), {
    imports: {
      chalk: "npm:chalk@^5",
      zod: "npm:zod@4.2.1",
      "date-fns": "npm:date-fns@4.1.0",
      bar: "npm:bar@1",
      foo: "npm:foo@2",
    },
    scopes: {
      "./vendor/a/mod.ts": {
        "zod/v4": "npm:zod@4.2.1/v4",
        "date-fns/addDays": "npm:date-fns@4.1.0/addDays",
        foo: "npm:foo@2",
      },
    },
  });
});
