/**
 * Rewrites the module specifiers in transpiled output to their Node form, plus the small fixups `deno transpile` needs.
 *
 * Specifiers are located by their span via `oxc-parser`.
 *
 * @module
 */

import { type Node, type ParseResult, parseSync } from "oxc-parser";
import { walk } from "oxc-walker";
import { BuildError } from "./errors.ts";

// ── Specifier locator (oxc) ───────────────────────────────────────────────────

/**
 * The oxc parse dialect for a file.
 *
 * A `.d.ts`/`.d.mts`/`.d.cts` is parsed as a declaration (so `export type … from` and `import("…").T` type queries
 * are seen), plain `.js` output as JavaScript.
 */
function dialect(filename: string): "dts" | "ts" | "js" {
  if (/\.d\.[cm]?ts$/.test(filename)) return "dts";
  if (/\.[cm]?ts$/.test(filename)) return "ts";
  return "js";
}

interface Span {
  start: number;
  end: number; // both quotes included
}

/** The spans (quotes included) of every module specifier in the parsed program. */
function specifierSpans(program: ParseResult["program"]): Span[] {
  const spans: Span[] = [];
  walk(program, {
    enter(node): void {
      // The string-literal node carrying this form's module specifier, if it has one.
      let source: Node | null | undefined;
      switch (node.type) {
        case "ImportDeclaration": // import x from "..."
        case "ExportNamedDeclaration": // export { y } from "..."
        case "ExportAllDeclaration": // export * from "..."
        case "ImportExpression": // import("...")
        case "TSImportType": // import("...").T  (.d.ts type query)
          source = node.source;
          break;
        // `import.meta.resolve("…")` instead holds it as the first argument of the call.
        case "CallExpression":
          if (
            node.callee.type === "MemberExpression" && !node.callee.computed &&
            node.callee.property.type === "Identifier" && node.callee.property.name === "resolve" &&
            node.callee.object.type === "MetaProperty" && node.callee.object.meta.name === "import" &&
            node.callee.object.property.name === "meta"
          ) {
            source = node.arguments[0];
          }
          break;
      }
      if (source?.type === "Literal" && typeof source.value === "string") {
        spans.push({ start: source.start, end: source.end });
      }
    },
  });
  return spans;
}

/**
 * Replaces every module specifier in {@linkcode code} with `rewrite(specifier)`.
 *
 * Only the quoted specifier text is spliced; everything else the transpiler emitted is left untouched.
 *
 * @param filename Selects the parse dialect (declaration / TypeScript / plain JS) and names the failure subject.
 *
 * @throws {BuildError} `REWRITE_PARSE_FAILED` when the parse collapses to an empty program.
 *
 * @example
 * ```ts
 * // The same `"./util.ts"` appears twice, but only the import specifier is spliced — a look-alike string literal is left as-is.
 * rewriteSpecifiers(`const p = "./util.ts";\nimport x from "./util.ts";`, "mod.js", (s) => s.replace(/\.ts$/, ".js"));
 * // -> `const p = "./util.ts";\nimport x from "./util.js";`
 * ```
 */
export function rewriteSpecifiers(code: string, filename: string, rewrite: (specifier: string) => string): string {
  const { program, errors } = parseSync(filename, code, { lang: dialect(filename) });
  // oxc reports some errors with the AST intact (e.g. a CommonJS top-level return) — those files must still build.
  // Only a parse collapsed to an empty program is fatal: it would ship every specifier silently unrewritten.
  if (errors.length > 0 && program.body.length === 0) {
    throw new BuildError("REWRITE_PARSE_FAILED", `cannot parse module: ${errors[0].message}`, filename);
  }
  // Sort by start: the single-cursor splice below is correct only for ascending spans, and oxc does not contract a
  // source-ordered traversal — so sort rather than depend on its current DFS happening to emit spans in order.
  const spans = specifierSpans(program).sort((a, b) => a.start - b.start);

  let out = "";
  let last = 0;
  // Span bounds include the quotes: keep them (slice to `start + 1`, resume at `end - 1`) and rewrite only the inner
  // specifier text.
  for (const { start, end } of spans) {
    out += code.slice(last, start + 1) + rewrite(code.slice(start + 1, end - 1));
    last = end - 1;
  }
  return out + code.slice(last);
}

// ── Transpile fixups ───────────────────────────────────────────────────

/**
 * Restores the `with { type: "json" }` attribute on JSON from-imports, which `deno transpile` drops from declarations.
 *
 * Sources are located via the parser, so look-alikes inside comments or unrelated strings are never touched.
 *
 * @param filename Selects the parse dialect (declaration / TypeScript / plain JS).
 */
export function restoreJsonAttributes(code: string, filename: string): string {
  const { program } = parseSync(filename, code, { lang: dialect(filename) });

  const inserts: number[] = [];
  walk(program, {
    enter(node): void {
      if (
        node.type !== "ImportDeclaration" &&
        node.type !== "ExportNamedDeclaration" &&
        node.type !== "ExportAllDeclaration"
      ) return;
      const source = node.source;
      if (
        source?.type === "Literal" && typeof source.value === "string" && source.value.endsWith(".json") &&
        node.attributes.length === 0
      ) {
        inserts.push(source.end);
      }
    },
  });

  // Same ordering caveat as in rewriteSpecifiers: sort, do not rely on the walker's traversal order.
  let out = "";
  let last = 0;
  for (const at of inserts.sort((a, b) => a - b)) {
    out += code.slice(last, at) + ` with { type: "json" }`;
    last = at;
  }
  return out + code.slice(last);
}

/** The trailing `//# sourceMappingURL=…` comment `deno transpile` omits when emitting a separate source map. */
export function sourceMappingComment(mapName: string): string {
  return `//# sourceMappingURL=${mapName}\n`;
}
