// deno-lint-ignore-file no-import-prefix

/**
 * Unit tests for the specifier and package-path helpers of `src/spec.ts`.
 *
 * @module
 */

import { assertEquals } from "jsr:@std/assert@1";
import {
  isRelative,
  jsrUrlPackage,
  makeResolver,
  parseRegistry,
  parseReplacement,
  relSpecifier,
  toPosix,
  tsToJs,
  vendoredRel,
  wildcardSubpath,
} from "../src/spec.ts";

Deno.test("parseRegistry", async (t) => {
  await t.step("npm: bare name, version range, version + subpath", () => {
    assertEquals(parseRegistry("npm:chalk"), { scheme: "npm", pkg: "chalk", version: undefined, subpath: "" });
    assertEquals(parseRegistry("npm:chalk@^5"), { scheme: "npm", pkg: "chalk", version: "^5", subpath: "" });
    assertEquals(parseRegistry("npm:chalk@5/foo"), { scheme: "npm", pkg: "chalk", version: "5", subpath: "/foo" });
  });

  await t.step("npm: scoped name", () => {
    assertEquals(parseRegistry("npm:@scope/pkg"), {
      scheme: "npm",
      pkg: "@scope/pkg",
      version: undefined,
      subpath: "",
    });
    assertEquals(parseRegistry("npm:@scope/pkg@1.2.3/sub/deep"), {
      scheme: "npm",
      pkg: "@scope/pkg",
      version: "1.2.3",
      subpath: "/sub/deep",
    });
  });

  await t.step("jsr: scoped name, version range, subpath", () => {
    assertEquals(parseRegistry("jsr:@std/encoding"), {
      scheme: "jsr",
      pkg: "@std/encoding",
      version: undefined,
      subpath: "",
    });
    assertEquals(parseRegistry("jsr:@std/encoding@1.0.0/hex"), {
      scheme: "jsr",
      pkg: "@std/encoding",
      version: "1.0.0",
      subpath: "/hex",
    });
  });

  await t.step("a leading slash after the scheme is tolerated", () => {
    assertEquals(parseRegistry("npm:/chalk"), { scheme: "npm", pkg: "chalk", version: undefined, subpath: "" });
    assertEquals(parseRegistry("jsr:/@std/x"), { scheme: "jsr", pkg: "@std/x", version: undefined, subpath: "" });
  });

  await t.step("a non-registry scheme, or a bare/relative specifier, returns null", () => {
    assertEquals(parseRegistry("node:fs"), null);
    assertEquals(parseRegistry("chalk"), null);
    assertEquals(parseRegistry("./local.ts"), null);
    assertEquals(parseRegistry("@scope/pkg"), null);
    // The scheme is anchored at the start: an https URL whose path merely contains `npm:`/`jsr:` is not a match.
    assertEquals(parseRegistry("https://esm.sh/npm:chalk"), null);
    assertEquals(parseRegistry("https://esm.sh/jsr:@a/b"), null);
  });
});

Deno.test("jsrUrlPackage", async (t) => {
  await t.step("extracts @scope/name from a jsr.io URL", () => {
    assertEquals(jsrUrlPackage("https://jsr.io/@std/encoding/1.0.0/hex.ts"), "@std/encoding");
    assertEquals(jsrUrlPackage("https://jsr.io/@scope/name/2.1.0/mod.ts"), "@scope/name");
  });

  await t.step("non-jsr.io or malformed URLs return null", () => {
    assertEquals(jsrUrlPackage("https://example.com/@std/x/1.0.0/y.ts"), null);
    assertEquals(jsrUrlPackage("https://esm.sh/foo/bar.ts"), null);
    // The jsr.io prefix must be anchored at the START: a jsr.io URL embedded in another host's query is not a match.
    assertEquals(jsrUrlPackage("https://esm.sh/?u=https://jsr.io/@a/b/1.0.0/m.ts"), null);
  });
});

Deno.test("parseReplacement", async (t) => {
  await t.step("bare name, no version", () => {
    assertEquals(parseReplacement("valibot"), { name: "valibot", version: undefined });
  });

  await t.step("name with version range", () => {
    assertEquals(parseReplacement("valibot@^1"), { name: "valibot", version: "^1" });
  });

  await t.step("scoped name, with and without version", () => {
    assertEquals(parseReplacement("@scope/pkg"), { name: "@scope/pkg", version: undefined });
    assertEquals(parseReplacement("@scope/pkg@1.2.3"), { name: "@scope/pkg", version: "1.2.3" });
  });
});

Deno.test("isRelative", async (t) => {
  await t.step("true for ./ and ../", () => {
    assertEquals(isRelative("./x.ts"), true);
    assertEquals(isRelative("../a/b.ts"), true);
  });

  await t.step("false for bare, absolute, and scheme specifiers", () => {
    assertEquals(isRelative("x.ts"), false);
    assertEquals(isRelative("/abs/x.ts"), false);
    assertEquals(isRelative("npm:chalk"), false);
    assertEquals(isRelative("@scope/x"), false);
    assertEquals(isRelative("https://example.com/x.ts"), false);
  });
});

Deno.test("vendoredRel", async (t) => {
  await t.step("mirrors host + pathname under the given deps dir", () => {
    assertEquals(
      vendoredRel("https://jsr.io/@std/encoding/1.0.0/hex.ts", "_deps"),
      "_deps/jsr.io/@std/encoding/1.0.0/hex.ts",
    );
    assertEquals(vendoredRel("https://esm.sh/foo@1/bar.ts", "_deps"), "_deps/esm.sh/foo@1/bar.ts");
  });

  await t.step("a custom deps dir replaces the default prefix", () => {
    assertEquals(vendoredRel("https://jsr.io/@std/x/1.0.0/mod.ts", "vendor"), "vendor/jsr.io/@std/x/1.0.0/mod.ts");
  });

  await t.step("query string is dropped (documented host+pathname collision)", () => {
    assertEquals(
      vendoredRel("https://jsr.io/@std/x/1.0.0/mod.ts?v=2", "_deps"),
      "_deps/jsr.io/@std/x/1.0.0/mod.ts",
    );
  });
});

Deno.test("tsToJs", async (t) => {
  await t.step("swaps a trailing .ts only", () => {
    assertEquals(tsToJs("mod.ts"), "mod.js");
    assertEquals(tsToJs("a/b/mod.ts"), "a/b/mod.js");
    assertEquals(tsToJs("mod.js"), "mod.js");
    assertEquals(tsToJs("data.json"), "data.json");
    assertEquals(tsToJs("mod.mts"), "mod.mts");
  });
});

Deno.test("toPosix", async (t) => {
  await t.step("rewrites backslashes to forward slashes", () => {
    assertEquals(toPosix("a\\b\\c.ts"), "a/b/c.ts");
    assertEquals(toPosix("a/b/c.ts"), "a/b/c.ts");
  });
});

Deno.test("relSpecifier", async (t) => {
  await t.step("sibling file gets a ./ prefix", () => {
    assertEquals(relSpecifier("mod.js", "util.js"), "./util.js");
  });

  await t.step("walks up to a different subtree", () => {
    assertEquals(
      relSpecifier("api/client.js", "_deps/jsr.io/@std/x/1.0.0/mod.js"),
      "../_deps/jsr.io/@std/x/1.0.0/mod.js",
    );
    assertEquals(relSpecifier("a/b/mod.js", "a/c/util.js"), "../c/util.js");
  });
});

Deno.test("wildcardSubpath", async (t) => {
  await t.step("substitutes the file's * capture into the subpath pattern", () => {
    assertEquals(wildcardSubpath("./*", "./src/*.ts", "./src/a.ts"), "./a");
  });

  await t.step("a `.d.ts` match captures the trailing `.d` (the pattern's literal suffix is only `.ts`)", () => {
    assertEquals(wildcardSubpath("./*", "./src/*.ts", "./src/types.d.ts"), "./types.d");
  });
});

Deno.test("makeResolver", async (t) => {
  const resolve = makeResolver({
    "chalk": "npm:chalk@^5",
    "@std/encoding": "jsr:@std/encoding",
    "@a": "alias-a",
    "@a/b": "alias-ab",
    "@dir/": "jsr:/@dir/",
    "$u": "./src/util.ts",
  }, "file:///repo/deno.json");
  const REF = "file:///repo/src/mod.ts";

  await t.step("an exact alias maps to its specifier", () => {
    assertEquals(resolve("chalk", REF), "npm:chalk@^5");
  });

  await t.step("a prefix alias appends the subpath, preserving the boundary slash", () => {
    assertEquals(resolve("@std/encoding/hex", REF), "jsr:@std/encoding/hex");
  });

  await t.step("the longest matching prefix wins", () => {
    // `@a/b` (→ alias-ab) must win over `@a` (→ alias-a) for `@a/b/mod`.
    assertEquals(resolve("@a/b/mod", REF), "alias-ab/mod");
  });

  await t.step("a trailing-slash (directory) alias maps its subpath", () => {
    assertEquals(resolve("@dir/sub", REF), "jsr:/@dir/sub");
  });

  await t.step("a specifier sharing an alias's text but crossing no '/' boundary is not claimed", () => {
    // `@a` must not claim `@abc`; it falls through to URL resolution against the referrer.
    assertEquals(resolve("@abc", REF), "file:///repo/src/@abc");
  });

  await t.step("a non-alias specifier resolves as a URL against the referrer", () => {
    assertEquals(resolve("./sibling.ts", REF), "file:///repo/src/sibling.ts");
  });

  await t.step("a relative import-map target resolves against the deno.json base, not the referrer", () => {
    // `$u` → "./src/util.ts" is relative to the import map (deno.json at /repo), so it must resolve to /repo/src/util.ts
    // — not against the referrer at /repo/src/, which would double the `src/`. Returning the raw relative string makes
    // @deno/graph drop the edge, so this resolution is what lets an alias to a local file work at all.
    assertEquals(resolve("$u", REF), "file:///repo/src/util.ts");
  });
});
