// deno-lint-ignore-file no-import-prefix

/**
 * Unit tests for the oxc-based specifier locator and the `deno transpile` output fixups.
 *
 * @module
 */

import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { BuildError } from "../src/errors.ts";
import { restoreJsonAttributes, rewriteSpecifiers, sourceMappingComment } from "../src/rewrite.ts";

// Wraps each located specifier in <…> so the test can assert both which specifiers were seen and that only the
// quoted text — not a byte around it — was spliced.
function rw(code: string, file: string): { out: string; seen: string[] } {
  const seen: string[] = [];
  const out = rewriteSpecifiers(code, file, (s) => {
    seen.push(s);
    return `<${s}>`;
  });
  return { out, seen };
}

Deno.test("rewriteSpecifiers — locates every specifier form", async (t) => {
  await t.step("static import", () => {
    const { out, seen } = rw(`import x from "./util.ts";`, "mod.js");
    assertEquals(out, `import x from "<./util.ts>";`);
    assertEquals(seen, ["./util.ts"]);
  });

  await t.step("export … from", () => {
    const { out, seen } = rw(`export { y } from "./y.ts";`, "mod.js");
    assertEquals(out, `export { y } from "<./y.ts>";`);
    assertEquals(seen, ["./y.ts"]);
  });

  await t.step("export * from", () => {
    const { out, seen } = rw(`export * from "./all.ts";`, "mod.js");
    assertEquals(out, `export * from "<./all.ts>";`);
    assertEquals(seen, ["./all.ts"]);
  });

  await t.step("dynamic import() mid-expression", () => {
    const { out, seen } = rw(`const m = await import("./dyn.ts");`, "mod.js");
    assertEquals(out, `const m = await import("<./dyn.ts>");`);
    assertEquals(seen, ["./dyn.ts"]);
  });

  await t.step("import.meta.resolve()", () => {
    const { out, seen } = rw(`const u = import.meta.resolve("./asset.bin");`, "mod.js");
    assertEquals(out, `const u = import.meta.resolve("<./asset.bin>");`);
    assertEquals(seen, ["./asset.bin"]);
  });

  await t.step("export type … from (declaration dialect)", () => {
    const { out, seen } = rw(`export type { T } from "./t.ts";`, "mod.d.ts");
    assertEquals(out, `export type { T } from "<./t.ts>";`);
    assertEquals(seen, ["./t.ts"]);
  });

  await t.step("TSImportType type query (declaration dialect)", () => {
    const { out, seen } = rw(`export declare const x: import("./types.ts").Foo;`, "mod.d.ts");
    assertEquals(out, `export declare const x: import("<./types.ts>").Foo;`);
    assertEquals(seen, ["./types.ts"]);
  });
});

Deno.test("rewriteSpecifiers — leaves non-specifier strings alone", async (t) => {
  await t.step("a string literal that looks like a path is not rewritten", () => {
    const { out, seen } = rw(`const s = "./fake.ts";\nimport x from "./real.ts";`, "mod.js");
    assertEquals(out, `const s = "./fake.ts";\nimport x from "<./real.ts>";`);
    assertEquals(seen, ["./real.ts"]);
  });

  await t.step("multiple specifiers of differing lengths splice independently", () => {
    const { out, seen } = rw(`import a from "./a.ts";\nimport bbb from "./bbbbbb.ts";`, "mod.js");
    assertEquals(out, `import a from "<./a.ts>";\nimport bbb from "<./bbbbbb.ts>";`);
    assertEquals(seen, ["./a.ts", "./bbbbbb.ts"]);
  });

  await t.step("a node: builtin specifier is still located (the callback decides to keep it)", () => {
    const seen: string[] = [];
    const out = rewriteSpecifiers(`import { readFile } from "node:fs/promises";`, "mod.js", (s) => {
      seen.push(s);
      return s;
    });
    assertEquals(out, `import { readFile } from "node:fs/promises";`);
    assertEquals(seen, ["node:fs/promises"]);
  });

  await t.step("a `.resolve()` look-alike (not import.meta.resolve) is left untouched", () => {
    // Only `import.meta.resolve(...)` is a specifier site; `Promise.resolve` / `path.resolve` must not be rewritten.
    const code = `const a = Promise.resolve("./payload.ts");\nconst b = path.resolve("./dir.ts");`;
    const { out, seen } = rw(code, "mod.js");
    assertEquals(out, code);
    assertEquals(seen, []);
  });

  await t.step("non-ASCII before a specifier does not shift the splice (UTF-16, not byte, offsets)", () => {
    const { out, seen } = rw(`const s = "💥💥💥";\nimport x from "./util.ts";`, "mod.js");
    assertEquals(out, `const s = "💥💥💥";\nimport x from "<./util.ts>";`);
    assertEquals(seen, ["./util.ts"]);
  });
});

Deno.test("rewriteSpecifiers — a parse failure fails the build instead of shipping unrewritten specifiers", async (t) => {
  await t.step("a collapsed parse (empty program) throws REWRITE_PARSE_FAILED", () => {
    // A collapsed parse would otherwise pass through with every specifier silently left as-is.
    const e = assertThrows(() => rewriteSpecifiers(`import x from ;`, "mod.js", (s) => s), BuildError);
    assertEquals(e.code, "REWRITE_PARSE_FAILED");
    assertEquals(e.subject, "mod.js");
  });

  await t.step(
    "a recoverable diagnostic with an intact AST does not throw (top-level return is legal CommonJS)",
    () => {
      const code = `if (globalThis.skip) return;\nmodule.exports = { x: 1 };\n`;
      assertEquals(rewriteSpecifiers(code, "legacy.cjs", (s) => s), code);
    },
  );
});

Deno.test("restoreJsonAttributes", async (t) => {
  await t.step('re-adds the with { type: "json" } attribute dropped from declarations', () => {
    assertEquals(
      restoreJsonAttributes(`import data from "./config.json";`, "mod.d.ts"),
      `import data from "./config.json" with { type: "json" };`,
    );
    assertEquals(
      restoreJsonAttributes(`export * from "./x.json";`, "mod.d.ts"),
      `export * from "./x.json" with { type: "json" };`,
    );
  });

  await t.step("non-json imports are untouched", () => {
    assertEquals(restoreJsonAttributes(`import x from "./util.js";`, "mod.d.ts"), `import x from "./util.js";`);
  });

  await t.step("a .json path inside a comment or unrelated string is untouched", () => {
    const code = `/**\n * Example: import data from "./config.json";\n */\nexport declare const s: string;\n`;
    assertEquals(restoreJsonAttributes(code, "mod.d.ts"), code);
  });

  await t.step("an import that already carries the attribute is not doubled", () => {
    const code = `import data from "./config.json" with { type: "json" };`;
    assertEquals(restoreJsonAttributes(code, "mod.d.ts"), code);
  });
});

Deno.test("sourceMappingComment", async (t) => {
  await t.step("formats the trailing sourceMappingURL comment", () => {
    assertEquals(sourceMappingComment("mod.js.map"), "//# sourceMappingURL=mod.js.map\n");
  });
});
