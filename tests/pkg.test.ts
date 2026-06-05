// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "jsr:@std/assert@1";
import { resolve, toFileUrl } from "jsr:@std/path@^1";
import type { PackageJson } from "type-fest";
import { type Analysis, analyze } from "../src/analyze.ts";
import type { RawDependency, RawGraph, RawModule } from "../src/graph.ts";
import type { Plan } from "../src/intake.ts";
import { planPackageJson } from "../src/pkg.ts";

function plan(exports: Record<string, string>, packageJson: PackageJson = {}): Plan {
  return {
    repoRoot: "/repo",
    outDir: "/repo/dist",
    codeDir: "/repo/dist/esm",
    tmpDir: "/repo/dist/.dts-tmp",
    name: "@x/lib",
    version: "1.0.0",
    exports,
    imports: {},
    npmReplacements: {},
    packageJson,
    copyFiles: [],
    sourceMap: "separate",
    depsDir: "_deps",
  };
}

function fileUrl(rel: string): string {
  return toFileUrl(resolve("/repo", rel)).href;
}

function dep(specifier: string, resolved: string | undefined): RawDependency {
  return { specifier, resolved };
}

function mod(specifier: string, mediaType: string | undefined, deps: RawDependency[] = []): RawModule {
  return { specifier, mediaType, error: undefined, dependencies: deps };
}

function graph(modules: RawModule[]): RawGraph {
  return { modules, readSource: () => Promise.reject(new Error("readSource is not used by analyze")) };
}

// Build the Analysis from the REAL analyze() over a synthetic graph, so srcRoot (and every path derived from it) is the
// engine's own value — the helper can never fabricate a wrong one. Each entry source is a leaf module; npm deps are
// injected through the import map, where analyze derives them. Cases with non-entry local deps build the graph directly.
function analysis(p: Plan, npmDeps: Record<string, string> = {}): Analysis {
  const imports: Record<string, string> = {};
  for (const [name, range] of Object.entries(npmDeps)) imports[name] = `npm:${name}@${range}`;
  const modules = Object.values(p.exports).map((src) =>
    mod(fileUrl(src), src.endsWith(".d.ts") ? "Dts" : "TypeScript")
  );
  return analyze({ ...p, imports }, graph(modules));
}

Deno.test("planPackageJson", async (t) => {
  await t.step("multi-entry: exports map + root main/types + dependencies", () => {
    const pkg = planPackageJson(
      analysis(plan({ ".": "./src/mod.ts", "./sub": "./src/sub.ts" }), { chalk: "^5" }),
    );
    assertEquals(pkg, {
      name: "@x/lib",
      version: "1.0.0",
      type: "module",
      main: "./esm/mod.js",
      types: "./esm/mod.d.ts",
      exports: {
        ".": { types: "./esm/mod.d.ts", default: "./esm/mod.js" },
        "./sub": { types: "./esm/sub.d.ts", default: "./esm/sub.js" },
      },
      dependencies: { chalk: "^5" },
    });
  });

  await t.step("computed fields win over author-supplied package.json", () => {
    const pkg = planPackageJson(
      analysis(
        plan({ ".": "./src/mod.ts" }, {
          name: "WRONG",
          version: "0.0.0",
          type: "commonjs",
          description: "kept",
          license: "MIT",
        }),
      ),
    );
    assertEquals(pkg.name, "@x/lib");
    assertEquals(pkg.version, "1.0.0");
    assertEquals(pkg.type, "module");
    assertEquals(pkg.description, "kept");
    assertEquals(pkg.license, "MIT");
  });

  await t.step("a .d.ts-only entry yields { types } with no default and no root main", () => {
    const pkg = planPackageJson(analysis(plan({ ".": "./src/types.d.ts" })));
    assertEquals(pkg.exports, { ".": { types: "./esm/types.d.ts" } });
    assertEquals("main" in pkg, false);
    assertEquals(pkg.types, "./esm/types.d.ts");
  });

  await t.step("no dependencies key when npmDeps is empty", () => {
    const pkg = planPackageJson(analysis(plan({ ".": "./src/mod.ts" })));
    assertEquals("dependencies" in pkg, false);
  });

  await t.step("root main/types are omitted when there is no '.' entry", () => {
    const pkg = planPackageJson(analysis(plan({ "./sub": "./src/sub.ts" })));
    assertEquals("main" in pkg, false);
    assertEquals("types" in pkg, false);
    assertEquals(pkg.exports, { "./sub": { types: "./esm/sub.d.ts", default: "./esm/sub.js" } });
  });

  await t.step("entry points in nested subdirectories keep their nesting under esm/", () => {
    const pkg = planPackageJson(analysis(plan({ ".": "./src/a/mod.ts", "./b": "./src/b/deep/mod.ts" })));
    assertEquals(pkg.exports, {
      ".": { types: "./esm/a/mod.d.ts", default: "./esm/a/mod.js" },
      "./b": { types: "./esm/b/deep/mod.d.ts", default: "./esm/b/deep/mod.js" },
    });
    assertEquals(pkg.main, "./esm/a/mod.js");
  });

  await t.step(
    "srcRoot accounts for a non-entry local dep above the entry dir (real analyze, not exports-only)",
    () => {
      // Entry src/deep/mod.ts imports ../shared.ts. The engine's srcRoot is the common ancestor of ALL local files
      // (/repo/src), so the `.` entry's path keeps its `deep/` segment. An exports-only srcRoot would wrongly drop it.
      const p = plan({ ".": "./src/deep/mod.ts" });
      const a = analyze(
        { ...p, imports: {} },
        graph([
          mod(fileUrl("src/deep/mod.ts"), "TypeScript", [dep("../shared.ts", fileUrl("src/shared.ts"))]),
          mod(fileUrl("src/shared.ts"), "TypeScript"),
        ]),
      );
      assertEquals(a.srcRoot, "/repo/src");
      const exports = planPackageJson(a).exports as Record<string, unknown>;
      assertEquals(exports["."], { types: "./esm/deep/mod.d.ts", default: "./esm/deep/mod.js" });
    },
  );

  await t.step("a `.ts` segment before the final extension survives (the types regex is end-anchored)", () => {
    // With two entries srcRoot is /repo/src, so the `.` entry's package-relative path is `v1.ts.bak/mod.ts`. Only the
    // TRAILING `.ts` may become `.d.ts`; the `.ts` inside the `v1.ts.bak` directory segment must stay verbatim.
    const pkg = planPackageJson(analysis(plan({ ".": "./src/v1.ts.bak/mod.ts", "./other": "./src/other.ts" })));
    assertEquals((pkg.exports as Record<string, unknown>)["."], {
      types: "./esm/v1.ts.bak/mod.d.ts",
      default: "./esm/v1.ts.bak/mod.js",
    });
    assertEquals(pkg.types, "./esm/v1.ts.bak/mod.d.ts");
  });
});
