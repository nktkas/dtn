// deno-lint-ignore-file no-import-prefix
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { analyze } from "../src/analyze.ts";
import { BuildError } from "../src/errors.ts";
import type { RawDependency, RawGraph, RawMediaType, RawModule } from "../src/graph.ts";
import type { Plan } from "../src/intake.ts";

const REPO = "/repo";

function plan(
  exports: Record<string, string>,
  imports: Record<string, string> = {},
  npmReplacements: Record<string, string> = {},
  depsDir = "_deps",
): Plan {
  return {
    repoRoot: REPO,
    outDir: "/repo/dist",
    codeDir: "/repo/dist/esm",
    tmpDir: "/repo/dist/.dts-tmp",
    name: "@x/lib",
    version: "1.0.0",
    exports,
    imports,
    npmReplacements,
    packageJson: {},
    copyFiles: [],
    sourceMap: "separate",
    depsDir,
  };
}

function fileUrl(rel: string): string {
  return `file://${REPO}/${rel}`;
}

function mod(specifier: string, mediaType: RawMediaType | undefined, deps: RawDependency[], error?: string): RawModule {
  return { specifier, mediaType, error, dependencies: deps };
}

function dep(specifier: string, resolved: string | undefined): RawDependency {
  return { specifier, resolved };
}

// analyze never calls readSource (that is the vendor stage); a rejecting stub guards against accidental use.
function graph(modules: RawModule[]): RawGraph {
  return { modules, readSource: () => Promise.reject(new Error("readSource is not used by analyze")) };
}

function sorted(xs: string[]): string[] {
  return [...xs].sort();
}

function throwsCode(fn: () => unknown, code: string): void {
  const e = assertThrows(fn, BuildError);
  assertEquals((e as BuildError).code, code);
}

Deno.test("analyze — classifies a representative graph", async (t) => {
  const g = graph([
    mod(fileUrl("src/mod.ts"), "TypeScript", [
      dep("./util.ts", fileUrl("src/util.ts")),
      dep("./data.json", fileUrl("src/data.json")),
      dep("npm:chalk@^5", "npm:chalk@^5"),
      dep("node:fs", "node:fs"),
      dep("jsr:@std/encoding@1.0.0/hex", "https://jsr.io/@std/encoding/1.0.0/hex.ts"),
    ]),
    mod(fileUrl("src/util.ts"), "TypeScript", []),
    mod(fileUrl("src/data.json"), "Json", []),
    mod("npm:chalk@^5", undefined, [], "load rejected or errored"),
    mod("node:fs", undefined, []),
    mod("https://jsr.io/@std/encoding/1.0.0/hex.ts", "TypeScript", [
      dep("./_common.ts", "https://jsr.io/@std/encoding/1.0.0/_common.ts"),
    ]),
    mod("https://jsr.io/@std/encoding/1.0.0/_common.ts", "TypeScript", []),
  ]);
  const a = analyze(plan({ ".": "./src/mod.ts" }), g);

  await t.step("local .ts → transpile, local .json → copy", () => {
    assertEquals(sorted(a.localFiles), ["/repo/src/mod.ts", "/repo/src/util.ts"]);
    assertEquals(a.localCopies, ["/repo/src/data.json"]);
  });

  await t.step("remote .ts (and its transitive .ts) → vendored code", () => {
    assertEquals(
      a.vendoredCode,
      new Map([
        ["https://jsr.io/@std/encoding/1.0.0/hex.ts", {
          src: "_deps/jsr.io/@std/encoding/1.0.0/hex.ts",
          emit: "_deps/jsr.io/@std/encoding/1.0.0/hex.js",
        }],
        ["https://jsr.io/@std/encoding/1.0.0/_common.ts", {
          src: "_deps/jsr.io/@std/encoding/1.0.0/_common.ts",
          emit: "_deps/jsr.io/@std/encoding/1.0.0/_common.js",
        }],
      ]),
    );
    assertEquals(a.vendoredAssets.size, 0);
  });

  await t.step("npm leaf → dependency; node: → no dependency", () => {
    assertEquals(a.npmDeps, { chalk: "^5" });
  });

  await t.step("srcRoot is the common ancestor of local sources", () => {
    assertEquals(a.srcRoot, "/repo/src");
  });

  await t.step("the vendored jsr specifier resolves to its staged and emitted paths", () => {
    assertEquals(a.specifiers.resolve("jsr:@std/encoding@1.0.0/hex"), {
      kind: "vendored",
      src: "_deps/jsr.io/@std/encoding/1.0.0/hex.ts",
      emit: "_deps/jsr.io/@std/encoding/1.0.0/hex.js",
    });
  });

  await t.step("a relative specifier of a vendored module is not bound into the index (resolve stays null)", () => {
    assertEquals(a.specifiers.resolve("./_common.ts"), null);
  });
});

Deno.test("analyze — srcRoot of sources in divergent directories has no trailing separator", () => {
  // Two entries in different top-level dirs make @std/path `common()` return a path WITH a trailing slash ("/repo/");
  // analyze must strip it so the package code root mirrors cleanly below srcRoot.
  const g = graph([
    mod(fileUrl("src/a.ts"), "TypeScript", []),
    mod(fileUrl("lib/b.ts"), "TypeScript", []),
  ]);
  const a = analyze(plan({ ".": "./src/a.ts", "./b": "./lib/b.ts" }), g);
  assertEquals(a.srcRoot, "/repo");
});

Deno.test("analyze — local copy media types (.js / .d.ts / .wasm)", () => {
  const g = graph([
    mod(fileUrl("src/mod.ts"), "TypeScript", [
      dep("./legacy.js", fileUrl("src/legacy.js")),
      dep("./types.d.ts", fileUrl("src/types.d.ts")),
      dep("./lib.wasm", fileUrl("src/lib.wasm")),
    ]),
    mod(fileUrl("src/legacy.js"), "JavaScript", []),
    mod(fileUrl("src/types.d.ts"), "Dts", []),
    mod(fileUrl("src/lib.wasm"), "Wasm", []),
  ]);
  const a = analyze(plan({ ".": "./src/mod.ts" }), g);
  assertEquals(a.localFiles, ["/repo/src/mod.ts"]);
  assertEquals(sorted(a.localCopies), ["/repo/src/legacy.js", "/repo/src/lib.wasm", "/repo/src/types.d.ts"]);
});

Deno.test("analyze — remote JSON is vendored as a byte asset, not transpiled", () => {
  const g = graph([
    mod(fileUrl("src/mod.ts"), "TypeScript", [dep("https://esm.sh/data.json", "https://esm.sh/data.json")]),
    mod("https://esm.sh/data.json", "Json", []),
  ]);
  const a = analyze(plan({ ".": "./src/mod.ts" }), g);
  assertEquals(a.vendoredCode.size, 0);
  assertEquals(a.vendoredAssets, new Map([["https://esm.sh/data.json", "_deps/esm.sh/data.json"]]));
});

Deno.test("analyze — a remote .wasm module is vendored as a byte asset (path keeps the .wasm extension)", () => {
  const g = graph([
    mod(fileUrl("src/mod.ts"), "TypeScript", [dep("https://esm.sh/lib.wasm", "https://esm.sh/lib.wasm")]),
    mod("https://esm.sh/lib.wasm", "Wasm", []),
  ]);
  const a = analyze(plan({ ".": "./src/mod.ts" }), g);
  assertEquals(a.vendoredCode.size, 0);
  // Wasm is byte-copied (ASSET_MEDIA), not transpiled, so the inlined path keeps `.wasm` (no `.js` rewrite).
  assertEquals(a.vendoredAssets, new Map([["https://esm.sh/lib.wasm", "_deps/esm.sh/lib.wasm"]]));
});

Deno.test("analyze — a remote JavaScript module is vendored as a copy (rewritten, not transpiled)", () => {
  const g = graph([
    mod(fileUrl("src/mod.ts"), "TypeScript", [dep("https://esm.sh/x.js", "https://esm.sh/x.js")]),
    mod("https://esm.sh/x.js", "JavaScript", []),
  ]);
  const a = analyze(plan({ ".": "./src/mod.ts" }), g);
  // A remote `.js` is neither transpiled (vendoredCode) nor a byte asset — it is a copy that the rewrite pass fixes up.
  assertEquals(a.vendoredCode.size, 0);
  assertEquals(a.vendoredAssets.size, 0);
  assertEquals(a.vendoredCopies, new Map([["https://esm.sh/x.js", "_deps/esm.sh/x.js"]]));
  // A copy is its own source: staged and emitted paths coincide.
  assertEquals(a.specifiers.resolve("https://esm.sh/x.js"), {
    kind: "vendored",
    src: "_deps/esm.sh/x.js",
    emit: "_deps/esm.sh/x.js",
  });
});

Deno.test("analyze — a remote .d.ts is vendored as a copy (types-only, keeps its .d.ts extension)", () => {
  const g = graph([
    mod(fileUrl("src/mod.ts"), "TypeScript", [dep("https://esm.sh/types.d.ts", "https://esm.sh/types.d.ts")]),
    mod("https://esm.sh/types.d.ts", "Dts", []),
  ]);
  const a = analyze(plan({ ".": "./src/mod.ts" }), g);
  // A declaration is copied like a JS module (no transpile), but its path keeps `.d.ts` — there is no `.js` twin.
  assertEquals(a.vendoredCopies, new Map([["https://esm.sh/types.d.ts", "_deps/esm.sh/types.d.ts"]]));
  assertEquals(a.specifiers.resolve("https://esm.sh/types.d.ts"), {
    kind: "vendored",
    src: "_deps/esm.sh/types.d.ts",
    emit: "_deps/esm.sh/types.d.ts",
  });
});

Deno.test("analyze — a vendored package importing another vendored package (cross-package chain)", () => {
  // Local code vendors package A; A's code imports a different package B (different scope). Neither has an npm twin,
  // so both inline, and A's cross-package import of B binds to B's inlined .js — the transitive-vendor case.
  // The vendor-internal edge uses the form @deno/graph actually emits for a jsr→jsr import: a leading slash after
  // `jsr:` and the source's caret range (`jsr:/@y/b@^2.0.0`), not a pinned no-slash specifier.
  const g = graph([
    mod(fileUrl("src/mod.ts"), "TypeScript", [dep("jsr:@x/a@1.0.0", "https://jsr.io/@x/a/1.0.0/mod.ts")]),
    mod("https://jsr.io/@x/a/1.0.0/mod.ts", "TypeScript", [
      dep("jsr:/@y/b@^2.0.0", "https://jsr.io/@y/b/2.0.0/mod.ts"),
    ]),
    mod("https://jsr.io/@y/b/2.0.0/mod.ts", "TypeScript", []),
  ]);
  const a = analyze(plan({ ".": "./src/mod.ts" }), g);
  assertEquals(
    a.vendoredCode,
    new Map([
      ["https://jsr.io/@x/a/1.0.0/mod.ts", {
        src: "_deps/jsr.io/@x/a/1.0.0/mod.ts",
        emit: "_deps/jsr.io/@x/a/1.0.0/mod.js",
      }],
      ["https://jsr.io/@y/b/2.0.0/mod.ts", {
        src: "_deps/jsr.io/@y/b/2.0.0/mod.ts",
        emit: "_deps/jsr.io/@y/b/2.0.0/mod.js",
      }],
    ]),
  );
  assertEquals(a.specifiers.resolve("jsr:@x/a@1.0.0"), {
    kind: "vendored",
    src: "_deps/jsr.io/@x/a/1.0.0/mod.ts",
    emit: "_deps/jsr.io/@x/a/1.0.0/mod.js",
  });
  assertEquals(a.specifiers.resolve("jsr:/@y/b@^2.0.0"), {
    kind: "vendored",
    src: "_deps/jsr.io/@y/b/2.0.0/mod.ts",
    emit: "_deps/jsr.io/@y/b/2.0.0/mod.js",
  });
});

Deno.test("analyze — a custom depsDir replaces the _deps prefix in vendored paths", () => {
  const g = graph([
    mod(fileUrl("src/mod.ts"), "TypeScript", [dep("jsr:@x/a@1.0.0", "https://jsr.io/@x/a/1.0.0/mod.ts")]),
    mod("https://jsr.io/@x/a/1.0.0/mod.ts", "TypeScript", []),
  ]);
  const a = analyze(plan({ ".": "./src/mod.ts" }, {}, {}, "vendor"), g);
  assertEquals(
    a.vendoredCode,
    new Map([["https://jsr.io/@x/a/1.0.0/mod.ts", {
      src: "vendor/jsr.io/@x/a/1.0.0/mod.ts",
      emit: "vendor/jsr.io/@x/a/1.0.0/mod.js",
    }]]),
  );
  assertEquals(a.specifiers.resolve("jsr:@x/a@1.0.0"), {
    kind: "vendored",
    src: "vendor/jsr.io/@x/a/1.0.0/mod.ts",
    emit: "vendor/jsr.io/@x/a/1.0.0/mod.js",
  });
});

Deno.test("analyze — import-map npm entries", async (t) => {
  await t.step("an imported npm: alias is declared with its version", () => {
    const g = graph([
      mod(fileUrl("src/mod.ts"), "TypeScript", [dep("chalk", "npm:chalk@^5")]),
      mod("npm:chalk@^5", undefined, [], "load rejected or errored"),
    ]);
    const a = analyze(plan({ ".": "./src/mod.ts" }, { chalk: "npm:chalk@^5" }), g);
    assertEquals(a.npmDeps, { chalk: "^5" });
  });

  await t.step("a versionless npm: import-map alias is declared as '*'", () => {
    const g = graph([
      mod(fileUrl("src/mod.ts"), "TypeScript", [dep("chalk", "npm:chalk")]),
      mod("npm:chalk", undefined, [], "load rejected or errored"),
    ]);
    const a = analyze(plan({ ".": "./src/mod.ts" }, { chalk: "npm:chalk" }), g);
    assertEquals(a.npmDeps, { chalk: "*" });
  });

  await t.step("a direct npm: alias carrying a subpath resolves to the bare name plus the subpath", () => {
    const g = graph([
      mod(fileUrl("src/mod.ts"), "TypeScript", [dep("myalias", "npm:pkg@1/sub")]),
      mod("npm:pkg@1/sub", undefined, [], "load rejected or errored"),
    ]);
    const a = analyze(plan({ ".": "./src/mod.ts" }, { myalias: "npm:pkg@1/sub" }), g);
    assertEquals(a.specifiers.resolve("myalias"), { kind: "npm", bare: "pkg/sub" });
  });
});

Deno.test("analyze — an import-map alias pointing at a local file binds to that file's emitted path", () => {
  // Both alias targets resolve (via the graph) to local modules; the binding must emit a `.ts` as `.js` but keep a
  // `.d.ts` verbatim (it is copied, with no `.js` twin), so the rewrite pass turns each alias into a relative import.
  const g = graph([
    mod(fileUrl("src/mod.ts"), "TypeScript", [
      dep("$u", fileUrl("src/util.ts")),
      dep("$t", fileUrl("src/types.d.ts")),
    ]),
    mod(fileUrl("src/util.ts"), "TypeScript", []),
    mod(fileUrl("src/types.d.ts"), "Dts", []),
  ]);
  const a = analyze(plan({ ".": "./src/mod.ts" }, { "$u": "./src/util.ts", "$t": "./src/types.d.ts" }), g);
  assertEquals(a.specifiers.resolve("$u"), { kind: "local", rel: "util.js" });
  assertEquals(a.specifiers.resolve("$t"), { kind: "local", rel: "types.d.ts" });
});

Deno.test("analyze — replaced jsr packages are pruned and declared as npm", () => {
  const g = graph([
    mod(fileUrl("src/mod.ts"), "TypeScript", [
      dep("@valibot/valibot", "https://jsr.io/@valibot/valibot/1.3.1/mod.ts"),
    ]),
    mod("https://jsr.io/@valibot/valibot/1.3.1/mod.ts", "TypeScript", [
      dep("./schema.ts", "https://jsr.io/@valibot/valibot/1.3.1/schema.ts"),
    ]),
    mod("https://jsr.io/@valibot/valibot/1.3.1/schema.ts", "TypeScript", []),
  ]);
  const a = analyze(
    plan({ ".": "./src/mod.ts" }, { "@valibot/valibot": "jsr:@valibot/valibot@1.3.1" }, {
      "@valibot/valibot": "valibot",
    }),
    g,
  );
  // The replaced package is an external leaf: neither it nor its transitive schema.ts is vendored.
  assertEquals(a.vendoredCode.size, 0);
  assertEquals(a.npmDeps, { valibot: "1.3.1" });
});

Deno.test("analyze — replacement version resolution", async (t) => {
  const g = graph([
    mod(fileUrl("src/mod.ts"), "TypeScript", [dep("@v/v", "https://jsr.io/@valibot/valibot/1.3.1/mod.ts")]),
    mod("https://jsr.io/@valibot/valibot/1.3.1/mod.ts", "TypeScript", []),
  ]);

  await t.step("version comes from the alias's jsr specifier when the replacement omits it", () => {
    const a = analyze(
      plan({ ".": "./src/mod.ts" }, { "@v/v": "jsr:@valibot/valibot@1.3.1" }, { "@v/v": "valibot" }),
      g,
    );
    assertEquals(a.npmDeps, { valibot: "1.3.1" });
  });

  await t.step("an explicit version in the replacement value wins", () => {
    const a = analyze(
      plan({ ".": "./src/mod.ts" }, { "@v/v": "jsr:@valibot/valibot@1.3.1" }, { "@v/v": "valibot@^2" }),
      g,
    );
    assertEquals(a.npmDeps, { valibot: "^2" });
  });

  await t.step("no explicit version and a versionless alias import → declared as '*'", () => {
    const a = analyze(
      plan({ ".": "./src/mod.ts" }, { "@v/v": "jsr:@valibot/valibot" }, { "@v/v": "valibot" }),
      g,
    );
    assertEquals(a.npmDeps, { valibot: "*" });
  });
});

Deno.test("analyze — npm version collision collapses to one entry", () => {
  // Two entry points pin different versions of chalk. The contract collapses them to a single npm dependency; which
  // version wins is left undefined (one version per package), so this pins only the invariant, not the walk order.
  const g = graph([
    mod(fileUrl("src/a.ts"), "TypeScript", [dep("npm:chalk@5.3.0", "npm:chalk@5.3.0")]),
    mod(fileUrl("src/b.ts"), "TypeScript", [dep("npm:chalk@5.4.0", "npm:chalk@5.4.0")]),
    mod("npm:chalk@5.3.0", undefined, [], "load rejected or errored"),
    mod("npm:chalk@5.4.0", undefined, [], "load rejected or errored"),
  ]);
  const a = analyze(plan({ ".": "./src/a.ts", "./b": "./src/b.ts" }), g);
  assertEquals(Object.keys(a.npmDeps), ["chalk"]);
  assertEquals(["5.3.0", "5.4.0"].includes(a.npmDeps.chalk), true);
});

Deno.test("analyze — a versionless npm leaf is declared as '*'", () => {
  const g = graph([
    mod(fileUrl("src/mod.ts"), "TypeScript", [dep("npm:leftpad", "npm:leftpad")]),
    mod("npm:leftpad", undefined, [], "load rejected or errored"),
  ]);
  const a = analyze(plan({ ".": "./src/mod.ts" }), g);
  assertEquals(a.npmDeps, { leftpad: "*" });
});

Deno.test("analyze — an npm leaf carrying the real graph's error field is still classified external", () => {
  // @deno/graph sets error="load rejected or errored" on npm: nodes; fateOf must check the npm: scheme BEFORE the
  // error field, so the package is declared, not thrown as MODULE_LOAD_FAILED.
  const g = graph([
    mod(fileUrl("src/mod.ts"), "TypeScript", [dep("npm:chalk@^5", "npm:chalk@^5")]),
    mod("npm:chalk@^5", undefined, [], "load rejected or errored"),
  ]);
  const a = analyze(plan({ ".": "./src/mod.ts" }), g);
  assertEquals(a.npmDeps, { chalk: "^5" });
});

Deno.test("analyze — a vendored module may import a replaced package via its raw jsr specifier", () => {
  // Inside vendored third-party code this is legitimate (rewritten to npm); only LOCAL code importing a replaced
  // package via its raw jsr specifier is a REPLACEMENT_DIRECT_IMPORT error — this pins that the check is local-only.
  const g = graph([
    mod(fileUrl("src/mod.ts"), "TypeScript", [dep("@other/x", "https://jsr.io/@other/x/1.0.0/mod.ts")]),
    mod("https://jsr.io/@other/x/1.0.0/mod.ts", "TypeScript", [
      dep("jsr:@valibot/valibot@1.3.1", "https://jsr.io/@valibot/valibot/1.3.1/mod.ts"),
    ]),
    mod("https://jsr.io/@valibot/valibot/1.3.1/mod.ts", "TypeScript", []),
  ]);
  const p = plan(
    { ".": "./src/mod.ts" },
    { "@other/x": "jsr:@other/x@1.0.0", "@valibot/valibot": "jsr:@valibot/valibot@1.3.1" },
    { "@valibot/valibot": "valibot" },
  );
  const a = analyze(p, g); // must not throw
  assertEquals(a.npmDeps, { valibot: "1.3.1" });
  assertEquals(a.vendoredCode.get("https://jsr.io/@other/x/1.0.0/mod.ts"), {
    src: "_deps/jsr.io/@other/x/1.0.0/mod.ts",
    emit: "_deps/jsr.io/@other/x/1.0.0/mod.js",
  });
  assertEquals(a.specifiers.resolve("@other/x"), {
    kind: "vendored",
    src: "_deps/jsr.io/@other/x/1.0.0/mod.ts",
    emit: "_deps/jsr.io/@other/x/1.0.0/mod.js",
  });
});

Deno.test("analyze — contract violations throw the documented BuildError", async (t) => {
  await t.step("UNSUPPORTED_LOCAL_SOURCE: a local module of an unhandled media type", () => {
    const g = graph([mod(fileUrl("src/mod.ts"), "Tsx", [])]);
    throwsCode(() => analyze(plan({ ".": "./src/mod.ts" }), g), "UNSUPPORTED_LOCAL_SOURCE");
  });

  await t.step("UNSUPPORTED_VENDORED_DEPENDENCY: a hostless remote dependency (a data: URL) cannot be vendored", () => {
    // A data: URL has no host+pathname to mirror under _deps, so it is rejected loudly rather than mis-vendored.
    const url = "data:text/javascript,export default 1";
    const g = graph([
      mod(fileUrl("src/mod.ts"), "TypeScript", [dep(url, url)]),
      mod(url, "JavaScript", []),
    ]);
    throwsCode(() => analyze(plan({ ".": "./src/mod.ts" }), g), "UNSUPPORTED_VENDORED_DEPENDENCY");
  });

  await t.step("MODULE_LOAD_FAILED: a module the graph could not load", () => {
    const g = graph([mod(fileUrl("src/mod.ts"), undefined, [], "load rejected")]);
    throwsCode(() => analyze(plan({ ".": "./src/mod.ts" }), g), "MODULE_LOAD_FAILED");
  });

  await t.step("MODULE_LOAD_FAILED: a remote dependency the graph could not load (the remote-path guard)", () => {
    // The case above is a local file:// module caught by the early error check; this exercises the SEPARATE guard on
    // the remote path. An errored remote module has no mediaType, so without that guard it would wrongly fall through
    // to UNSUPPORTED_VENDORED_DEPENDENCY instead of MODULE_LOAD_FAILED.
    const g = graph([
      mod(fileUrl("src/mod.ts"), "TypeScript", [dep("https://esm.sh/x", "https://esm.sh/x.ts")]),
      mod("https://esm.sh/x.ts", undefined, [], "load rejected or errored"),
    ]);
    throwsCode(() => analyze(plan({ ".": "./src/mod.ts" }), g), "MODULE_LOAD_FAILED");
  });

  await t.step("UNRESOLVED_SPECIFIER: a bare specifier that is neither vendored nor npm", () => {
    const g = graph([mod(fileUrl("src/mod.ts"), "TypeScript", [dep("mystery-bare", undefined)])]);
    throwsCode(() => analyze(plan({ ".": "./src/mod.ts" }), g), "UNRESOLVED_SPECIFIER");
  });

  await t.step("REPLACEMENT_DIRECT_IMPORT: local code imports a replaced package via its raw jsr specifier", () => {
    const g = graph([
      mod(fileUrl("src/mod.ts"), "TypeScript", [
        dep("jsr:@valibot/valibot@1.3.1", "https://jsr.io/@valibot/valibot/1.3.1/mod.ts"),
      ]),
      mod("https://jsr.io/@valibot/valibot/1.3.1/mod.ts", "TypeScript", []),
    ]);
    const p = plan({ ".": "./src/mod.ts" }, { "@valibot/valibot": "jsr:@valibot/valibot@1.3.1" }, {
      "@valibot/valibot": "valibot",
    });
    throwsCode(() => analyze(p, g), "REPLACEMENT_DIRECT_IMPORT");
  });
});
