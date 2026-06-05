// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "jsr:@std/assert@1";
import { SpecifierIndex } from "../src/analyze.ts";

// One index exercising every resolve branch. `@a` and `@a/b` map to different npm names so that resolving `@a/b`
// proves the longest-alias-first ordering (the shorter `@a` prefix would otherwise win and yield `a-short/b`).
function makeIndex(): SpecifierIndex {
  return new SpecifierIndex({
    vendored: new Map([["@remote/x", "_deps/esm.sh/x/1.0.0/mod.js"]]),
    aliases: [
      { alias: "chalk", npmName: "chalk", subpath: "", version: "^5" },
      { alias: "@std/encoding/hex", npmName: "@std/encoding", subpath: "/hex", version: "^1" },
      { alias: "@a", npmName: "a-short", subpath: "", version: "1" },
      { alias: "@a/b", npmName: "a-long", subpath: "", version: "1" },
      { alias: "$p", npmName: "prefixpkg", subpath: "", version: "1" },
    ],
    replacedJsrPackages: new Map([["@valibot/valibot", "valibot"]]),
    npmDeps: { chalk: "^5", "@std/encoding": "^1", "a-short": "1", "a-long": "1", prefixpkg: "1", valibot: "^1" },
  });
}

Deno.test("SpecifierIndex.resolve", async (t) => {
  const idx = makeIndex();

  await t.step("a written specifier bound to a vendored file", () => {
    assertEquals(idx.resolve("@remote/x"), { kind: "vendored", rel: "_deps/esm.sh/x/1.0.0/mod.js" });
  });

  await t.step("an exact alias → npm name", () => {
    assertEquals(idx.resolve("chalk"), { kind: "npm", bare: "chalk" });
  });

  await t.step("an alias carrying a subpath", () => {
    assertEquals(idx.resolve("@std/encoding/hex"), { kind: "npm", bare: "@std/encoding/hex" });
  });

  await t.step("the longest matching alias wins", () => {
    assertEquals(idx.resolve("@a/b"), { kind: "npm", bare: "a-long" });
  });

  await t.step("a prefix alias appends the remaining subpath", () => {
    assertEquals(idx.resolve("$p/deep/mod"), { kind: "npm", bare: "prefixpkg/deep/mod" });
  });

  await t.step("a directly-written jsr specifier of a replaced package → npm", () => {
    assertEquals(idx.resolve("jsr:@valibot/valibot@1/schemas"), { kind: "npm", bare: "valibot/schemas" });
  });

  await t.step("a raw npm specifier → bare npm name + subpath", () => {
    assertEquals(idx.resolve("npm:lodash@4/fp"), { kind: "npm", bare: "lodash/fp" });
  });

  await t.step("node: builtins and unknown specifiers resolve to null", () => {
    assertEquals(idx.resolve("node:fs"), null);
    assertEquals(idx.resolve("https://unknown.example/x.ts"), null);
  });

  await t.step("a specifier sharing an alias's leading text but crossing no '/' boundary falls through", () => {
    // `@a` (→ a-short) must not claim `@abc`; the prefix match requires a `/` boundary, not a bare startsWith.
    assertEquals(idx.resolve("@abc"), null);
  });

  await t.step("a prefix alias embedded mid-string is not matched (the prefix is anchored at the start)", () => {
    // `$p` must only match when the specifier STARTS with `$p/`; the same text mid-string must not hijack it.
    assertEquals(idx.resolve("x/$p/y"), null);
  });
});

Deno.test("SpecifierIndex.replacedJsrConflict", async (t) => {
  const idx = makeIndex();

  await t.step("a jsr specifier of a replaced package returns its npm name", () => {
    assertEquals(idx.replacedJsrConflict("jsr:@valibot/valibot@1"), "valibot");
  });

  await t.step("the https://jsr.io/ URL form also conflicts", () => {
    assertEquals(idx.replacedJsrConflict("https://jsr.io/@valibot/valibot/1.0.0/mod.ts"), "valibot");
  });

  await t.step("a non-replaced jsr package and a non-jsr specifier return null", () => {
    assertEquals(idx.replacedJsrConflict("jsr:@std/encoding"), null);
    assertEquals(idx.replacedJsrConflict("npm:chalk"), null);
  });
});

Deno.test("SpecifierIndex.declarationImportMap", async (t) => {
  await t.step("aliases → npm: specifiers, vendored → local .ts", () => {
    assertEquals(makeIndex().declarationImportMap(), {
      "chalk": "npm:chalk@^5",
      "@std/encoding/hex": "npm:@std/encoding@^1/hex",
      "@a": "npm:a-short@1",
      "@a/b": "npm:a-long@1",
      "$p": "npm:prefixpkg@1",
      "@remote/x": "./_deps/esm.sh/x/1.0.0/mod.ts",
    });
  });
});

Deno.test("SpecifierIndex.vendorImportMap", async (t) => {
  await t.step("every npm dependency (incl. transitively discovered) → its npm: specifier", () => {
    assertEquals(makeIndex().vendorImportMap(), {
      "chalk": "npm:chalk@^5",
      "@std/encoding": "npm:@std/encoding@^1",
      "a-short": "npm:a-short@1",
      "a-long": "npm:a-long@1",
      "prefixpkg": "npm:prefixpkg@1",
      "valibot": "npm:valibot@^1",
    });
  });
});

Deno.test("SpecifierIndex.resolve — a prefix alias inserts its own subpath before the remaining tail", () => {
  const idx = new SpecifierIndex({
    vendored: new Map(),
    aliases: [{ alias: "@scoped", npmName: "realpkg", subpath: "/sub", version: "1" }],
    replacedJsrPackages: new Map(),
    npmDeps: { realpkg: "1" },
  });
  assertEquals(idx.resolve("@scoped/extra"), { kind: "npm", bare: "realpkg/sub/extra" });
});

Deno.test("SpecifierIndex — a local-file alias resolves to a package file and type-checks against its source", async (t) => {
  const idx = new SpecifierIndex({
    vendored: new Map(),
    localAliases: new Map([["$u", { rel: "util.js", source: "file:///repo/src/util.ts" }]]),
    aliases: [],
    replacedJsrPackages: new Map(),
    npmDeps: {},
  });

  await t.step("resolve → a local package file (rewritten by relative path, not a bare npm name)", () => {
    assertEquals(idx.resolve("$u"), { kind: "local", rel: "util.js" });
  });

  await t.step("declarationImportMap → the real source URL, so deno transpile resolves and checks it", () => {
    assertEquals(idx.declarationImportMap(), { "$u": "file:///repo/src/util.ts" });
  });
});

Deno.test("SpecifierIndex — a copied remote JS module keeps its .js, where a transpiled vendored dep maps to .ts", async (t) => {
  const idx = new SpecifierIndex({
    vendored: new Map([["@scope/ts", "_deps/esm.sh/ts/1.0.0/mod.js"]]),
    vendorCopies: new Map([["https://esm.sh/x.js", "_deps/esm.sh/x.js"]]),
    aliases: [],
    replacedJsrPackages: new Map(),
    npmDeps: {},
  });

  await t.step("resolve → a vendoredCopy target (a package file, rewritten by relative path)", () => {
    assertEquals(idx.resolve("https://esm.sh/x.js"), { kind: "vendoredCopy", rel: "_deps/esm.sh/x.js" });
  });

  await t.step("declarationImportMap: a transpiled vendored dep points at its `.ts` source, a copy stays `.js`", () => {
    assertEquals(idx.declarationImportMap(), {
      "@scope/ts": "./_deps/esm.sh/ts/1.0.0/mod.ts",
      "https://esm.sh/x.js": "./_deps/esm.sh/x.js",
    });
  });
});

Deno.test("SpecifierIndex.declarationImportMap — an import-map alias wins over a same-keyed vendored entry", () => {
  // The same string can be both an import-map alias and a written specifier bound to a vendored file. Aliases are
  // emitted first and the vendored loop uses `??=`, so the alias's `npm:` form must survive the collision.
  const idx = new SpecifierIndex({
    vendored: new Map([["chalk", "_deps/x/chalk.js"]]),
    aliases: [{ alias: "chalk", npmName: "chalk", subpath: "", version: "^5" }],
    replacedJsrPackages: new Map(),
    npmDeps: { chalk: "^5" },
  });
  assertEquals(idx.declarationImportMap().chalk, "npm:chalk@^5");
});
