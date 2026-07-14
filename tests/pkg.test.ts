// deno-lint-ignore-file no-import-prefix

/**
 * Unit tests for package metadata derived from analyzed build plans.
 *
 * @module
 */

import { assertEquals } from "jsr:@std/assert@1";
import { resolve, toFileUrl } from "jsr:@std/path@^1";
import type { PackageJson } from "type-fest";
import { type Analysis, analyze } from "../src/analyze.ts";
import type { RawDependency, RawGraph, RawMediaType, RawModule } from "../src/graph.ts";
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
    depsDir: "_deps",
  };
}

function fileUrl(rel: string): string {
  return toFileUrl(resolve("/repo", rel)).href;
}

function dep(specifier: string, resolved: string | undefined): RawDependency {
  return { specifier, resolved };
}

function mod(specifier: string, mediaType: RawMediaType | undefined, deps: RawDependency[] = []): RawModule {
  return { specifier, mediaType, error: undefined, dependencies: deps };
}

function graph(modules: RawModule[]): RawGraph {
  return { modules, readSource: () => Promise.reject(new Error("readSource is not used by analyze")) };
}

function analysis(p: Plan, npmDeps: Record<string, string> = {}): Analysis {
  const imports: Record<string, string> = {};
  for (const [name, range] of Object.entries(npmDeps)) imports[name] = `npm:${name}@${range}`;
  const modules = Object.values(p.exports).map((src) => mod(fileUrl(src), "TypeScript"));
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
    "entry output remains nested when a reachable dependency is above the entry directory",
    () => {
      const p = plan({ ".": "./src/deep/mod.ts" });
      const a = analyze(
        { ...p, imports: {} },
        graph([
          mod(fileUrl("src/deep/mod.ts"), "TypeScript", [dep("../shared.ts", fileUrl("src/shared.ts"))]),
          mod(fileUrl("src/shared.ts"), "TypeScript"),
        ]),
      );
      const exports = planPackageJson(a).exports as Record<string, unknown>;
      assertEquals(exports["."], { types: "./esm/deep/mod.d.ts", default: "./esm/deep/mod.js" });
    },
  );

  await t.step("a `.ts` segment before the final extension survives in runtime and declaration paths", () => {
    const pkg = planPackageJson(analysis(plan({ ".": "./src/v1.ts.bak/mod.ts", "./other": "./src/other.ts" })));
    assertEquals((pkg.exports as Record<string, unknown>)["."], {
      types: "./esm/v1.ts.bak/mod.d.ts",
      default: "./esm/v1.ts.bak/mod.js",
    });
    assertEquals(pkg.types, "./esm/v1.ts.bak/mod.d.ts");
  });
});
