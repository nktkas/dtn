// deno-lint-ignore-file no-import-prefix

/**
 * Unit tests for registry parsing, package paths, and the supported deno.json import-map subset.
 *
 * @module
 */

import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { makeResolver, parseRegistry, parseReplacement, vendoredRel } from "../src/spec.ts";

Deno.test("parseRegistry", () => {
  assertEquals(parseRegistry("npm:chalk@^5/sub"), {
    scheme: "npm",
    pkg: "chalk",
    version: "^5",
    subpath: "/sub",
  });
  assertEquals(parseRegistry("jsr:/@std/encoding@1/hex"), {
    scheme: "jsr",
    pkg: "@std/encoding",
    version: "1",
    subpath: "/hex",
  });
  assertEquals(parseRegistry("node:fs"), null);
});

Deno.test("parseReplacement", () => {
  assertEquals(parseReplacement("valibot@^1"), { name: "valibot", version: "^1" });
  assertEquals(parseReplacement("@scope/pkg"), { name: "@scope/pkg", version: undefined });
  assertEquals(parseReplacement(""), null);
  assertEquals(parseReplacement("@broken"), null);
});

Deno.test("vendoredRel — portable media-aware URL identity", async (t) => {
  await t.step("uses a media-specific artifact inside a directory representing the complete URL", () => {
    assertEquals(
      vendoredRel("https://jsr.io/@std/encoding/1.0.0/hex.ts", "_deps", "TypeScript"),
      "_deps/h-jsr~2eio/p-~40std/p-encoding/p-1~2e0~2e0/p-hex~2ets/mod.ts",
    );
    assertEquals(
      vendoredRel("https://jsr.io/@scope/pkg/1/mod", "_deps", "Mjs"),
      "_deps/h-jsr~2eio/p-~40scope/p-pkg/p-1/p-mod/mod.mjs",
    );
  });

  await t.step("query, media, and path case cannot collapse to the same path", () => {
    const base = "https://jsr.io/@scope/pkg/1/mod";
    assertNotEquals(
      vendoredRel(`${base}?x=1`, "_deps", "TypeScript"),
      vendoredRel(`${base}?x=2`, "_deps", "TypeScript"),
    );
    assertNotEquals(
      vendoredRel(base, "_deps", "TypeScript"),
      vendoredRel(`${base}?`, "_deps", "TypeScript"),
    );
    assertNotEquals(
      vendoredRel(base, "_deps", "TypeScript"),
      vendoredRel(`${base}#`, "_deps", "TypeScript"),
    );
    assertNotEquals(
      vendoredRel(`${base}#a`, "_deps", "TypeScript"),
      vendoredRel(`${base}?#a`, "_deps", "TypeScript"),
    );
    assertNotEquals(
      vendoredRel(base, "_deps", "TypeScript"),
      vendoredRel(base, "_deps", "JavaScript"),
    );
    assertNotEquals(
      vendoredRel(base, "_deps", "TypeScript"),
      vendoredRel("https://jsr.io/@scope/pkg/1/Mod", "_deps", "TypeScript"),
    );
    assertNotEquals(
      vendoredRel("data:application/typescript,export%20const%20value%20%3D%201", "_deps", "TypeScript"),
      vendoredRel("data:Application/typescript,export%20const%20value%20%3D%201", "_deps", "TypeScript"),
    );
  });

  await t.step("long URL segments are split below filesystem component limits", () => {
    const path = vendoredRel(
      `https://jsr.io/@scope/pkg/1/${"a".repeat(119)}.${"A".repeat(200)}.ts`,
      "_deps",
      "TypeScript",
    );
    assertEquals(path.split("/").every((component) => new TextEncoder().encode(component).length <= 122), true);
    assertEquals(path.split("/").every((component) => !component.endsWith(".")), true);
  });
});

Deno.test("makeResolver", async (t) => {
  const resolve = makeResolver({
    "@std/encoding": "jsr:@std/encoding@^1",
    "@scope/": "jsr:@scope/pkg@1/",
    "@scope/pkg": "jsr:@scope/specific@2",
    chalk: "npm:chalk@^5",
  });
  const referrer = "file:///repo/src/mod.ts";

  await t.step("matches exact aliases and uses the longest package prefix", () => {
    assertEquals(resolve("chalk", referrer), "npm:chalk@^5");
    assertEquals(resolve("@std/encoding/hex", referrer), "jsr:@std/encoding@^1/hex");
    assertEquals(resolve("@scope/util", referrer), "jsr:@scope/pkg@1/util");
    assertEquals(resolve("@scope/pkg/util", referrer), "jsr:@scope/specific@2/util");
  });

  await t.step("resolves relative URLs but leaves an unmapped bare specifier bare", () => {
    assertEquals(resolve("./util.ts", referrer), "file:///repo/src/util.ts");
    assertEquals(resolve("unknown", referrer), "unknown");
    assertEquals(resolve("constructor", referrer), "constructor");
    assertEquals(resolve("__proto__", referrer), "__proto__");
  });
});
