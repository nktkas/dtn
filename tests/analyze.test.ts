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
  assertEquals(analysis.specifiers.resolve(root, "chalk"), {
    kind: "npm",
    bare: "chalk",
    registry: "npm:chalk@^5",
  });
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
  await t.step("local JavaScript, MJS, JSON, and declaration dependencies are copied", () => {
    const root = fileUrl("src/mod.ts");
    const files = [
      fileUrl("src/a.js"),
      fileUrl("src/b.mjs"),
      fileUrl("src/data.json"),
      fileUrl("src/types.d.ts"),
      fileUrl("src/types.d.mts"),
      fileUrl("src/types.d.cts"),
    ];
    const analysis = analyze(
      plan(),
      graph([
        module(root, "TypeScript", [
          dependency("./a.js", files[0]),
          dependency("./b.mjs", files[1]),
          dependency("./data.json", files[2]),
          dependency("./types.d.ts", files[3]),
          dependency("./types.d.mts", files[4]),
          dependency("./types.d.cts", files[5]),
        ]),
        module(files[0], "JavaScript"),
        module(files[1], "Mjs"),
        module(files[2], "Json"),
        module(files[3], "Dts"),
        module(files[4], "Dmts"),
        module(files[5], "Dcts"),
      ]),
    );
    assertEquals([...analysis.localCopies].sort(), [
      "/repo/src/a.js",
      "/repo/src/b.mjs",
      "/repo/src/data.json",
      "/repo/src/types.d.cts",
      "/repo/src/types.d.mts",
      "/repo/src/types.d.ts",
    ]);
  });

  await t.step("JSR JavaScript, MJS, and declarations retain media-specific artifacts", () => {
    const root = fileUrl("src/mod.ts");
    const js = "https://jsr.io/@scope/pkg/1/a";
    const mjs = "https://jsr.io/@scope/pkg/1/b";
    const dts = "https://jsr.io/@scope/pkg/1/types";
    const dmts = "https://jsr.io/@scope/pkg/1/types.d.mts";
    const dcts = "https://jsr.io/@scope/pkg/1/types.d.cts";
    const analysis = analyze(
      plan(),
      graph([
        module(root, "TypeScript", [
          dependency("jsr:@scope/pkg@1/a", js),
          dependency("jsr:@scope/pkg@1/b", mjs),
          dependency("jsr:@scope/pkg@1/types", dts),
          dependency("jsr:@scope/pkg@1/types.mts", dmts),
          dependency("jsr:@scope/pkg@1/types.cts", dcts),
        ]),
        module(js, "JavaScript"),
        module(mjs, "Mjs"),
        module(dts, "Dts"),
        module(dmts, "Dmts"),
        module(dcts, "Dcts"),
      ]),
    );
    assertEquals(
      analysis.vendoredCopies,
      new Map([
        [js, vendoredRel(js, "_deps", "JavaScript")],
        [mjs, vendoredRel(mjs, "_deps", "Mjs")],
        [dts, vendoredRel(dts, "_deps", "Dts")],
        [dmts, vendoredRel(dmts, "_deps", "Dmts")],
        [dcts, vendoredRel(dcts, "_deps", "Dcts")],
      ]),
    );
  });

  await t.step("TypeScript from an arbitrary remote origin is vendored", () => {
    const root = fileUrl("src/mod.ts");
    const remote = "https://example.com/mod.ts";
    const analysis = analyze(
      plan(),
      graph([
        module(root, "TypeScript", [dependency(remote, remote)]),
        module(remote, "TypeScript"),
      ]),
    );
    const src = vendoredRel(remote, "_deps", "TypeScript");
    assertEquals(analysis.vendoredCode, new Map([[remote, { src, emit: tsToJs(src) }]]));
  });
});

Deno.test("analyze — unsupported module scope", async (t) => {
  for (const [name, media] of [["CommonJS", "Cjs"], ["Wasm", "Wasm"]] as const) {
    await t.step(`rejects local ${name}`, () => {
      const root = fileUrl("src/mod.ts");
      const target = fileUrl(`src/x-${name}`);
      throwsCode([
        module(root, "TypeScript", [dependency(`./x-${name}`, target)]),
        module(target, media),
      ], "UNSUPPORTED_MODULE");
    });
  }

  await t.step("rejects unsupported remote media", () => {
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
    assertEquals(analysis.specifiers.resolve(root, "@v/v"), {
      kind: "npm",
      bare: "valibot",
      registry: "npm:valibot@1.3.1",
    });
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
    assertEquals(analysis.specifiers.resolve(root, "chalk"), {
      kind: "npm",
      bare: "kleur",
      registry: "npm:kleur@^4",
    });
  });

  await t.step("replaces aliases independently within one JSR package", () => {
    const root = fileUrl("src/mod.ts");
    const hex = "https://jsr.io/@std/encoding/1.0.0/hex.ts";
    const base64 = "https://jsr.io/@std/encoding/1.0.0/base64.ts";
    const analysis = analyze(
      plan(
        {},
        {
          hex: "jsr:@std/encoding@1.0.0/hex",
          base64: "jsr:@std/encoding@1.0.0/base64",
        },
        { hex: "encoding-hex", base64: "encoding-base64" },
      ),
      graph([
        module(root, "TypeScript", [dependency("hex", hex), dependency("base64", base64)]),
        module(hex, "TypeScript"),
        module(base64, "TypeScript"),
      ]),
    );

    assertEquals(analysis.vendoredCode.size, 0);
    assertEquals(analysis.specifiers.resolve(root, "hex"), {
      kind: "npm",
      bare: "encoding-hex/hex",
      registry: "npm:encoding-hex@1.0.0/hex",
    });
    assertEquals(analysis.specifiers.resolve(root, "base64"), {
      kind: "npm",
      bare: "encoding-base64/base64",
      registry: "npm:encoding-base64@1.0.0/base64",
    });
    assertEquals(analysis.specifiers.declarationImportMap(), {
      imports: {
        hex: "npm:encoding-hex@1.0.0/hex",
        base64: "npm:encoding-base64@1.0.0/base64",
      },
      scopes: {},
    });
  });

  await t.step("vendors an unreplaced sibling alias", () => {
    const root = fileUrl("src/mod.ts");
    const hex = "https://jsr.io/@std/encoding/1.0.0/hex.ts";
    const base64 = "https://jsr.io/@std/encoding/1.0.0/base64.ts";
    const analysis = analyze(
      plan(
        {},
        {
          encoding: "jsr:@std/encoding@1.0.0/hex",
          "encoding/base64": "jsr:@std/encoding@1.0.0/base64",
        },
        { encoding: "encoding-npm" },
      ),
      graph([
        module(root, "TypeScript", [dependency("encoding", hex), dependency("encoding/base64", base64)]),
        module(hex, "TypeScript"),
        module(base64, "TypeScript"),
      ]),
    );

    const src = vendoredRel(base64, "_deps", "TypeScript");
    const target = { kind: "vendored" as const, src, emit: tsToJs(src) };
    assertEquals(analysis.vendoredCode, new Map([[base64, { src: target.src, emit: target.emit }]]));
    assertEquals(analysis.specifiers.resolve(root, "encoding"), {
      kind: "npm",
      bare: "encoding-npm/hex",
      registry: "npm:encoding-npm@1.0.0/hex",
    });
    assertEquals(analysis.specifiers.resolve(root, "encoding/base64"), target);
    assertEquals(analysis.specifiers.declarationImportMap(), {
      imports: {
        encoding: "npm:encoding-npm@1.0.0/hex",
        "encoding/base64": `./${src}`,
      },
      scopes: {},
    });
  });

  await t.step("prunes a replaced alias used by a vendored module", () => {
    const root = fileUrl("src/mod.ts");
    const parent = "https://jsr.io/@scope/parent/1.0.0/mod.ts";
    const shared = "https://jsr.io/@scope/shared/1.0.0/mod.ts";
    const analysis = analyze(
      plan(
        {},
        {
          parent: "jsr:@scope/parent@1.0.0",
          shared: "jsr:@scope/shared@1.0.0",
        },
        { shared: "shared-npm" },
      ),
      graph([
        module(root, "TypeScript", [dependency("parent", parent)]),
        module(parent, "TypeScript", [dependency("shared", shared)]),
        module(shared, "TypeScript"),
      ]),
    );

    assertEquals([...analysis.vendoredCode.keys()], [parent]);
    assertEquals(analysis.specifiers.resolve(parent, "shared"), {
      kind: "npm",
      bare: "shared-npm",
      registry: "npm:shared-npm@1.0.0",
    });
  });

  await t.step("vendors a direct JSR import independently of a replaced alias", () => {
    const root = fileUrl("src/mod.ts");
    const remote = "https://jsr.io/@valibot/valibot/1.3.1/mod.ts";
    const direct = "jsr:@valibot/valibot@1.3.1";
    const analysis = analyze(
      plan({}, { "@v/v": direct }, { "@v/v": "valibot" }),
      graph([
        module(root, "TypeScript", [dependency("@v/v", remote), dependency(direct, remote)]),
        module(remote, "TypeScript"),
      ]),
    );

    const src = vendoredRel(remote, "_deps", "TypeScript");
    assertEquals(analysis.specifiers.resolve(root, "@v/v"), {
      kind: "npm",
      bare: "valibot",
      registry: "npm:valibot@1.3.1",
    });
    assertEquals(analysis.specifiers.resolve(root, direct), { kind: "vendored", src, emit: tsToJs(src) });
  });
});

Deno.test("analyze — npm dependency requirements", async (t) => {
  await t.step("rejects conflicting replacement requirements", () => {
    const error = assertThrows(
      () =>
        analyze(
          plan(
            {},
            {
              hex: "jsr:@std/encoding@1.0.0/hex",
              base64: "jsr:@std/encoding@2.0.0/base64",
            },
            { hex: "encoding-npm@^1", base64: "encoding-npm@^2" },
          ),
          graph([module(fileUrl("src/mod.ts"), "TypeScript")]),
        ),
      BuildError,
    );
    assertEquals(error.code, "DEPENDENCY_FAILED");
    assertEquals(error.subject, "encoding-npm");
  });

  await t.step("rejects conflicting direct requirements", () => {
    const root = fileUrl("src/mod.ts");
    const error = assertThrows(
      () =>
        analyze(
          plan(),
          graph([
            module(root, "TypeScript", [
              dependency("npm:example@^1", "npm:example@^1"),
              dependency("npm:example@^2", "npm:example@^2"),
            ]),
            module("npm:example@^1", undefined),
            module("npm:example@^2", undefined),
          ]),
        ),
      BuildError,
    );
    assertEquals(error.code, "DEPENDENCY_FAILED");
    assertEquals(error.subject, "example");
  });

  await t.step("coalesces identical requirements", () => {
    const root = fileUrl("src/mod.ts");
    const analysis = analyze(
      plan({}, { a: "npm:example@^1", b: "npm:example@^1" }),
      graph([
        module(root, "TypeScript", [
          dependency("a", "npm:example@^1"),
          dependency("b", "npm:example@^1"),
        ]),
        module("npm:example@^1", undefined),
      ]),
    );
    assertEquals(analysis.npmDeps, { example: "^1" });
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
    {
      imports: Object.fromEntries([
        ["constructor", "npm:chalk@^5"],
        ["__proto__", "npm:kleur@^4"],
      ]),
      scopes: {},
    },
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
