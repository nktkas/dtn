// deno-lint-ignore-file no-import-prefix

/**
 * Unit tests for graph classification, edge bindings, media policy, and dependency errors.
 *
 * @module
 */

import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { analyze } from "../src/analyze.ts";
import { BuildError } from "../src/errors.ts";
import type { RawDependency, RawGraph, RawMediaType, RawModule } from "../src/graph.ts";
import type { Plan } from "../src/intake.ts";
import { tsToJs, vendoredRel } from "../src/spec.ts";

const REPO = "/repo";

function plan(
  exports: Record<string, string> = { ".": "./src/mod.ts" },
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
    depsDir,
  };
}

function fileUrl(path: string): string {
  return `file://${REPO}/${path}`;
}

function dependency(specifier: string, resolved: string | undefined): RawDependency {
  return { specifier, resolved };
}

function module(
  specifier: string,
  mediaType: RawMediaType | undefined,
  dependencies: RawDependency[] = [],
  error?: string,
): RawModule {
  return { specifier, mediaType, dependencies, error };
}

function graph(modules: RawModule[]): RawGraph {
  return { modules, readSource: () => Promise.reject(new Error("analyze does not read source")) };
}

function throwsCode(modules: RawModule[], code: string): BuildError {
  const error = assertThrows(() => analyze(plan(), graph(modules)), BuildError);
  assertEquals(error.code, code);
  return error;
}

Deno.test("analyze — representative local, npm, and JSR graph", () => {
  const root = fileUrl("src/mod.ts");
  const util = fileUrl("src/util.ts");
  const legacy = fileUrl("src/legacy.js");
  const remote = "https://jsr.io/@std/encoding/1.0.0/hex.ts";
  const analysis = analyze(
    plan({}, { hex: "jsr:@std/encoding@1.0.0/hex", chalk: "npm:chalk@^5" }),
    graph([
      module(root, "TypeScript", [
        dependency("./util.ts", util),
        dependency("./legacy.js", legacy),
        dependency("hex", remote),
        dependency("chalk", "npm:chalk@^5"),
        dependency("node:fs", "node:fs"),
      ]),
      module(util, "TypeScript"),
      module(legacy, "JavaScript"),
      module(remote, "TypeScript"),
      module("npm:chalk@^5", undefined, [], "load rejected or errored"),
      module("node:fs", undefined),
    ]),
  );

  assertEquals([...analysis.localFiles].sort(), ["/repo/src/mod.ts", "/repo/src/util.ts"]);
  assertEquals(analysis.localCopies, ["/repo/src/legacy.js"]);
  assertEquals(analysis.srcRoot, "/repo/src");
  assertEquals(analysis.npmDeps, { chalk: "^5" });

  const src = vendoredRel(remote, "_deps", "TypeScript");
  assertEquals(analysis.vendoredCode, new Map([[remote, { src, emit: tsToJs(src) }]]));
  assertEquals(analysis.specifiers.resolve(root, "hex"), { kind: "vendored", src, emit: tsToJs(src) });
  assertEquals(analysis.specifiers.resolve(root, "./util.ts"), { kind: "local", emit: "util.js", suffix: "" });
  assertEquals(analysis.specifiers.resolve(root, "chalk"), { kind: "npm", bare: "chalk" });
  assertEquals(analysis.specifiers.resolve(root, "node:fs"), null);
});

Deno.test("analyze — bindings are edge-aware for identical written specifiers", () => {
  const root = fileUrl("src/mod.ts");
  const a = "https://jsr.io/@scope/a/1/mod.ts";
  const b = "https://jsr.io/@scope/b/1/mod.ts";
  const aShared = "https://jsr.io/@scope/a/1/shared.ts";
  const bShared = "https://jsr.io/@scope/b/1/shared.ts";
  const analysis = analyze(
    plan(),
    graph([
      module(root, "TypeScript", [dependency("jsr:@scope/a@1", a), dependency("jsr:@scope/b@1", b)]),
      module(a, "TypeScript", [dependency("./shared.ts", aShared)]),
      module(b, "TypeScript", [dependency("./shared.ts", bShared)]),
      module(aShared, "TypeScript"),
      module(bShared, "TypeScript"),
    ]),
  );

  const aSrc = vendoredRel(aShared, "_deps", "TypeScript");
  const bSrc = vendoredRel(bShared, "_deps", "TypeScript");
  assertEquals(analysis.specifiers.resolve(a, "./shared.ts"), {
    kind: "vendored",
    src: aSrc,
    emit: tsToJs(aSrc),
  });
  assertEquals(analysis.specifiers.resolve(b, "./shared.ts"), {
    kind: "vendored",
    src: bSrc,
    emit: tsToJs(bSrc),
  });
});

Deno.test("analyze — a local query-bearing edge keeps URL identity while sharing its artifact", () => {
  const root = fileUrl("src/mod.ts");
  const queried = `${fileUrl("src/util.ts")}?mode=test`;
  const analysis = analyze(
    plan(),
    graph([
      module(root, "TypeScript", [dependency("./util.ts?mode=test", queried)]),
      module(queried, "TypeScript"),
    ]),
  );
  assertEquals(analysis.specifiers.resolve(root, "./util.ts?mode=test"), {
    kind: "local",
    emit: "util.js",
    suffix: "?mode=test",
  });
});

Deno.test("analyze — supported copied media", async (t) => {
  await t.step("local JavaScript, MJS, and declaration dependencies are copied", () => {
    const root = fileUrl("src/mod.ts");
    const files = [fileUrl("src/a.js"), fileUrl("src/b.mjs"), fileUrl("src/types.d.ts")];
    const analysis = analyze(
      plan(),
      graph([
        module(root, "TypeScript", [
          dependency("./a.js", files[0]),
          dependency("./b.mjs", files[1]),
          dependency("./types.d.ts", files[2]),
        ]),
        module(files[0], "JavaScript"),
        module(files[1], "Mjs"),
        module(files[2], "Dts"),
      ]),
    );
    assertEquals([...analysis.localCopies].sort(), ["/repo/src/a.js", "/repo/src/b.mjs", "/repo/src/types.d.ts"]);
  });

  await t.step("JSR JavaScript, MJS, and declarations retain media-specific artifacts", () => {
    const root = fileUrl("src/mod.ts");
    const js = "https://jsr.io/@scope/pkg/1/a";
    const mjs = "https://jsr.io/@scope/pkg/1/b";
    const dts = "https://jsr.io/@scope/pkg/1/types";
    const analysis = analyze(
      plan(),
      graph([
        module(root, "TypeScript", [
          dependency("jsr:@scope/pkg@1/a", js),
          dependency("jsr:@scope/pkg@1/b", mjs),
          dependency("jsr:@scope/pkg@1/types", dts),
        ]),
        module(js, "JavaScript"),
        module(mjs, "Mjs"),
        module(dts, "Dts"),
      ]),
    );
    assertEquals(
      analysis.vendoredCopies,
      new Map([
        [js, vendoredRel(js, "_deps", "JavaScript")],
        [mjs, vendoredRel(mjs, "_deps", "Mjs")],
        [dts, vendoredRel(dts, "_deps", "Dts")],
      ]),
    );
  });
});

Deno.test("analyze — unsupported module scope", async (t) => {
  for (const [name, media] of [["CommonJS", "Cjs"], ["JSON", "Json"], ["Wasm", "Wasm"]] as const) {
    await t.step(`rejects local ${name}`, () => {
      const root = fileUrl("src/mod.ts");
      const target = fileUrl(`src/x-${name}`);
      throwsCode([
        module(root, "TypeScript", [dependency(`./x-${name}`, target)]),
        module(target, media),
      ], "UNSUPPORTED_MODULE");
    });
  }

  await t.step("rejects arbitrary hosted modules outside JSR", () => {
    const root = fileUrl("src/mod.ts");
    const remote = "https://example.com/mod.ts";
    throwsCode([
      module(root, "TypeScript", [dependency(remote, remote)]),
      module(remote, "TypeScript"),
    ], "UNSUPPORTED_MODULE");
  });

  await t.step("rejects unsupported media inside JSR", () => {
    const root = fileUrl("src/mod.ts");
    const remote = "https://jsr.io/@scope/pkg/1/data.json";
    throwsCode([
      module(root, "TypeScript", [dependency("jsr:@scope/pkg@1/data", remote)]),
      module(remote, "Json"),
    ], "UNSUPPORTED_MODULE");
  });
});

Deno.test("analyze — npm replacements", async (t) => {
  await t.step("prunes the replaced JSR graph and binds the alias to npm", () => {
    const root = fileUrl("src/mod.ts");
    const remote = "https://jsr.io/@valibot/valibot/1.3.1/mod.ts";
    const analysis = analyze(
      plan({}, { "@v/v": "jsr:@valibot/valibot@1.3.1" }, { "@v/v": "valibot" }),
      graph([
        module(root, "TypeScript", [dependency("@v/v", remote)]),
        module(remote, "TypeScript"),
      ]),
    );
    assertEquals(analysis.vendoredCode.size, 0);
    assertEquals(analysis.npmDeps, { valibot: "1.3.1" });
    assertEquals(analysis.specifiers.resolve(root, "@v/v"), { kind: "npm", bare: "valibot" });
  });

  await t.step("replaces an npm-target alias without retaining the original npm dependency", () => {
    const root = fileUrl("src/mod.ts");
    const analysis = analyze(
      plan({}, { chalk: "npm:chalk@^5" }, { chalk: "kleur@^4" }),
      graph([
        module(root, "TypeScript", [dependency("chalk", "npm:chalk@^5")]),
        module("npm:chalk@^5", undefined, [], "load rejected or errored"),
      ]),
    );
    assertEquals(analysis.npmDeps, { kleur: "^4" });
    assertEquals(analysis.specifiers.resolve(root, "chalk"), { kind: "npm", bare: "kleur" });
  });

  await t.step("rejects a direct local import of a replaced JSR package", () => {
    const root = fileUrl("src/mod.ts");
    const remote = "https://jsr.io/@valibot/valibot/1.3.1/mod.ts";
    const error = assertThrows(
      () =>
        analyze(
          plan({}, { "@v/v": "jsr:@valibot/valibot@1.3.1" }, { "@v/v": "valibot" }),
          graph([
            module(root, "TypeScript", [dependency("jsr:@valibot/valibot@1.3.1", remote)]),
            module(remote, "TypeScript"),
          ]),
        ),
      BuildError,
    );
    assertEquals(error.code, "DEPENDENCY_FAILED");
  });
});

Deno.test("analyze — prototype-key aliases and npm packages remain own entries", () => {
  const root = fileUrl("src/mod.ts");
  const analysis = analyze(
    plan(
      {},
      Object.fromEntries([
        ["constructor", "npm:chalk@^5"],
        ["__proto__", "npm:kleur@^4"],
      ]),
    ),
    graph([
      module(root, "TypeScript", [
        dependency("constructor", "npm:chalk@^5"),
        dependency("__proto__", "npm:kleur@^4"),
        dependency("npm:constructor@0.0.6", "npm:constructor@0.0.6"),
      ]),
      module("npm:chalk@^5", undefined),
      module("npm:kleur@^4", undefined),
      module("npm:constructor@0.0.6", undefined),
    ]),
  );

  assertEquals(
    analysis.npmDeps,
    Object.fromEntries([
      ["chalk", "^5"],
      ["kleur", "^4"],
      ["constructor", "0.0.6"],
    ]),
  );
  assertEquals(
    analysis.specifiers.declarationImportMap(),
    Object.fromEntries([
      ["constructor", "npm:chalk@^5"],
      ["__proto__", "npm:kleur@^4"],
    ]),
  );
});

Deno.test("analyze — load and resolution failures share DEPENDENCY_FAILED", () => {
  throwsCode([module(fileUrl("src/mod.ts"), undefined, [], "load rejected")], "DEPENDENCY_FAILED");
  throwsCode([
    module(fileUrl("src/mod.ts"), "TypeScript", [dependency("unknown", undefined)]),
  ], "DEPENDENCY_FAILED");
});

Deno.test("analyze — custom depsDir participates in artifact paths", () => {
  const root = fileUrl("src/mod.ts");
  const remote = "https://jsr.io/@scope/pkg/1/mod.ts";
  const analysis = analyze(
    plan({}, {}, {}, "vendor"),
    graph([
      module(root, "TypeScript", [dependency("jsr:@scope/pkg@1", remote)]),
      module(remote, "TypeScript"),
    ]),
  );
  const src = vendoredRel(remote, "vendor", "TypeScript");
  assertEquals(analysis.vendoredCode.get(remote), { src, emit: tsToJs(src) });
});
