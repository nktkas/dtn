// deno-lint-ignore-file no-import-prefix

/**
 * Unit tests for static specifier rewriting and source-map composition.
 *
 * @module
 */

import { decode, encode, type SourceMapMappings } from "@jridgewell/sourcemap-codec";
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { BuildError } from "../src/errors.ts";
import {
  restoreSourceMapSource,
  rewriteSpecifiers,
  sourceMappingComment,
  updateGeneratedSourceMap,
} from "../src/rewrite.ts";

function rewrite(code: string, file: string): { code: string; seen: string[] } {
  const seen: string[] = [];
  const result = rewriteSpecifiers(code, file, (specifier) => {
    seen.push(specifier);
    return `${specifier}?rewritten`;
  });
  return { code: result.code, seen };
}

Deno.test("rewriteSpecifiers — static syntax only", async (t) => {
  await t.step("rewrites imports, re-exports, and declaration import types", () => {
    const source = `import x from "./x.ts";\nexport { y } from "./y.ts";\nexport * from "./z.ts";\n`;
    assertEquals(rewrite(source, "mod.js"), {
      code:
        `import x from "./x.ts?rewritten";\nexport { y } from "./y.ts?rewritten";\nexport * from "./z.ts?rewritten";\n`,
      seen: ["./x.ts", "./y.ts", "./z.ts"],
    });
    assertEquals(rewrite(`export declare const x: import("./types.ts").Foo;`, "mod.d.ts"), {
      code: `export declare const x: import("./types.ts?rewritten").Foo;`,
      seen: ["./types.ts"],
    });
  });

  await t.step("does not rewrite dynamic imports or import.meta.resolve", () => {
    const source = `const a = import("./a.ts");\nconst b = import.meta.resolve("./b.ts");\n`;
    assertEquals(rewrite(source, "mod.js"), { code: source, seen: [] });
  });

  await t.step("passes the decoded value and serializes the replacement safely", () => {
    const source = String.raw`import x from ".\u002fx.ts";`;
    const result = rewriteSpecifiers(source, "mod.js", (specifier) => {
      assertEquals(specifier, "./x.ts");
      return `./x\".js`;
    });
    assertEquals(result.code, `import x from "./x\\\".js";`);
  });

  await t.step("leaves unchanged literals byte-for-byte", () => {
    const source = `import x from './x.js';`;
    assertEquals(rewriteSpecifiers(source, "mod.js", (specifier) => specifier), { code: source, edits: [] });
  });

  await t.step("fails when parsing yields no usable module", () => {
    const error = assertThrows(() => rewriteSpecifiers(`import x from ;`, "mod.js", (s) => s), BuildError);
    assertEquals(error.code, "EMIT_FAILED");
    assertEquals(error.subject, "mod.js");
  });
});

Deno.test("source-map composition", async (t) => {
  await t.step("shifts generated columns after a rewritten specifier", () => {
    const before = `import x from "./x.ts"; export const y = x;\n`;
    const rewritten = rewriteSpecifiers(before, "mod.js", () => "./much-longer-name.js");
    const mappings: SourceMapMappings = [[[0, 0, 0, 0], [25, 0, 0, 25], [32, 0, 0, 32]]];
    const map = JSON.stringify({
      version: 3,
      file: "mod.js",
      sources: ["file:///src/mod.ts"],
      sourcesContent: [before],
      names: [],
      mappings: encode(mappings),
    });
    const updated = JSON.parse(
      updateGeneratedSourceMap(map, before, rewritten.code, rewritten.edits, "mod.js.map"),
    );
    const decoded = decode(updated.mappings);
    const delta = rewritten.code.length - before.length;
    assertEquals(decoded[0].map((segment) => segment[0]), [0, 25 + delta, 32 + delta]);
  });

  await t.step("maps vendored source positions back and records remote provenance", () => {
    const original = `export { x } from "jsr:@scope/x";\n`;
    const rewritten = rewriteSpecifiers(original, "mod.ts", () => "./p-x/mod.ts");
    const sourceColumn = rewritten.code.indexOf(";");
    const map = JSON.stringify({
      version: 3,
      file: "mod.js",
      sources: ["file:///tmp/vendor/mod.ts"],
      sourcesContent: [rewritten.code],
      names: [],
      mappings: encode([[[0, 0, 0, 0], [10, 0, 0, sourceColumn]]]),
    });
    const restored = JSON.parse(
      restoreSourceMapSource(
        map,
        rewritten.code,
        original,
        rewritten.edits,
        "https://jsr.io/@scope/pkg/1/mod.ts",
        "mod.js.map",
      ),
    );
    assertEquals(restored.sources, ["https://jsr.io/@scope/pkg/1/mod.ts"]);
    assertEquals(restored.sourcesContent, [original]);
    assertEquals(decode(restored.mappings)[0][1][3], original.indexOf(";"));
  });

  await t.step("preserves empty mapping lines", () => {
    const before = `import x from "./x.ts";\n\nexport const y = x;\n`;
    const rewritten = rewriteSpecifiers(before, "mod.js", () => "./longer.js");
    const map = JSON.stringify({
      version: 3,
      file: "mod.js",
      sources: ["file:///src/mod.ts"],
      sourcesContent: [before],
      names: [],
      mappings: encode([[[0, 0, 0, 0]], [], [[0, 0, 2, 0]]]),
    });
    const updated = JSON.parse(
      updateGeneratedSourceMap(map, before, rewritten.code, rewritten.edits, "mod.js.map"),
    );
    assertEquals(decode(updated.mappings)[1], []);
  });
});

Deno.test("sourceMappingComment", () => {
  assertEquals(sourceMappingComment("mod.js.map"), "//# sourceMappingURL=mod.js.map\n");
});
