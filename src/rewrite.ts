/**
 * Locates supported module specifiers, rewrites their literals, and keeps emitted source maps aligned with those edits.
 *
 * @module
 */

import { decode, encode, type SourceMapMappings, type SourceMapSegment } from "@jridgewell/sourcemap-codec";
import { type Node, type ParseResult, parseSync } from "oxc-parser";
import { walk } from "oxc-walker";
import { BuildError } from "./errors.ts";

const SOURCE_MAP_DIRECTIVE = /^[@#]\s*sourceMappingURL=(\S*?)\s*$/;

// =============================================================================
// Specifier rewriting
// =============================================================================

/** One replacement in UTF-16 offsets of the text before rewriting. */
export interface TextEdit {
  start: number;
  end: number;
  replacement: string;
}

/** Rewritten source and the edits needed to update its source map. */
export interface RewriteResult {
  code: string;
  edits: TextEdit[];
}

/** The oxc parse dialect for one emitted module or declaration. */
function dialect(filename: string): "dts" | "ts" | "js" {
  if (/\.d\.[cm]?ts$/.test(filename)) return "dts";
  if (/\.[cm]?ts$/.test(filename)) return "ts";
  return "js";
}

interface SpecifierSpan {
  start: number;
  end: number;
  value: string;
}

/** Locates static ESM, string-literal runtime import, and TypeScript import-type specifiers. */
function specifierSpans(program: ParseResult["program"]): SpecifierSpan[] {
  const spans: SpecifierSpan[] = [];
  walk(program, {
    enter(node): void {
      let source: Node | null | undefined;
      if (
        node.type === "ImportDeclaration" ||
        node.type === "ImportExpression" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration" ||
        node.type === "TSImportType"
      ) {
        source = node.source;
      }
      if (source?.type === "Literal" && typeof source.value === "string") {
        spans.push({ start: source.start, end: source.end, value: source.value });
      }
    },
  });
  return spans;
}

/**
 * Rewrites every supported module specifier using its decoded literal value.
 *
 * @param stripSourceMapDirectives Remove source map links when their external artifacts are intentionally not shipped.
 *
 * @throws {BuildError} `EMIT_FAILED` when parsing produces no usable syntax tree.
 */
export function rewriteSpecifiers(
  code: string,
  filename: string,
  rewrite: (specifier: string) => string,
  stripSourceMapDirectives = false,
): RewriteResult {
  const { program, errors, comments } = parseSync(filename, code, { lang: dialect(filename) });
  if (errors.length > 0 && program.body.length === 0) {
    throw new BuildError("EMIT_FAILED", `cannot parse module: ${errors[0].message}`, { subject: filename });
  }

  const edits: TextEdit[] = [];
  if (stripSourceMapDirectives) {
    for (const comment of comments) {
      if (!SOURCE_MAP_DIRECTIVE.test(comment.value)) continue;
      const replacement = comment.type === "Block"
        ? code.slice(comment.start, comment.end).replace(/[^\r\n\u2028\u2029]/g, " ")
        : "";
      edits.push({ start: comment.start, end: comment.end, replacement });
    }
  }
  for (const span of specifierSpans(program).sort((a, b) => a.start - b.start)) {
    const rewritten = rewrite(span.value);
    if (rewritten === span.value) continue;
    edits.push({ start: span.start, end: span.end, replacement: JSON.stringify(rewritten) });
  }
  edits.sort((a, b) => a.start - b.start);

  let out = "";
  let last = 0;
  for (const edit of edits) {
    out += code.slice(last, edit.start) + edit.replacement;
    last = edit.end;
  }
  return { code: out + code.slice(last), edits };
}

// =============================================================================
// Source maps
// =============================================================================

/**
 * Source Map Revision 3 fields used by the rewrite pass.
 *
 * @see https://tc39.es/ecma426/
 */
interface SourceMap {
  version: 3;
  file?: string;
  sourceRoot?: string;
  sources: string[];
  sourcesContent?: Array<string | null>;
  names: string[];
  mappings: string;
}

/** Replaces the compiler's absolute local source URL with a stable path relative to the final map. */
export function setSourceMapSource(text: string, source: string, filename: string): string {
  const map = parseSourceMap(text, filename);
  delete map.sourceRoot;
  map.sources = [source];
  return JSON.stringify(map);
}

/** Updates generated positions after edits to emitted JavaScript. */
export function updateGeneratedSourceMap(
  text: string,
  before: string,
  after: string,
  edits: TextEdit[],
  filename: string,
): string {
  try {
    if (edits.length === 0) return text;
    const map = parseSourceMap(text, filename);
    const mappings = decode(map.mappings);
    const beforeLines = lineStarts(before);
    const afterLines = lineStarts(after);
    const updated: SourceMapMappings = [];

    for (let line = 0; line < mappings.length; line++) {
      for (const segment of mappings[line]) {
        const offset = beforeLines[line] + segment[0];
        const position = offsetPosition(transformForward(offset, edits), afterLines);
        segment[0] = position.column;
        (updated[position.line] ??= []).push(segment);
      }
    }
    map.mappings = encode(normalizeMappings(updated));
    return JSON.stringify(map);
  } catch (cause) {
    if (cause instanceof BuildError) throw cause;
    throw new BuildError("EMIT_FAILED", "cannot update emitted source map", { subject: filename, cause });
  }
}

/** Rebinds a vendored map from its rewritten scratch source to the original remote source. */
export function restoreSourceMapSource(
  text: string,
  rewrittenSource: string,
  originalSource: string,
  edits: TextEdit[],
  sourceUrl: string,
  filename: string,
): string {
  try {
    const map = parseSourceMap(text, filename);
    const mappings = decode(map.mappings);
    if (edits.length > 0) {
      const rewrittenLines = lineStarts(rewrittenSource);
      const originalLines = lineStarts(originalSource);
      for (const line of mappings) {
        for (const segment of line) {
          if (segment.length === 1 || segment[1] !== 0) continue;
          const offset = rewrittenLines[segment[2]] + segment[3];
          const position = offsetPosition(transformBackward(offset, edits), originalLines);
          segment[2] = position.line;
          segment[3] = position.column;
        }
      }
      map.mappings = encode(mappings);
    }
    delete map.sourceRoot;
    map.sources = [sourceUrl];
    map.sourcesContent = [originalSource];
    return JSON.stringify(map);
  } catch (cause) {
    if (cause instanceof BuildError) throw cause;
    throw new BuildError("EMIT_FAILED", "cannot restore emitted source map provenance", { subject: filename, cause });
  }
}

/** Parses the compiler-owned source map and normalizes malformed JSON into the package error contract. */
function parseSourceMap(text: string, filename: string): SourceMap {
  try {
    return JSON.parse(text) as SourceMap;
  } catch (cause) {
    throw new BuildError("EMIT_FAILED", "cannot parse emitted source map", { subject: filename, cause });
  }
}

/** UTF-16 offset of the first character on every line. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (character === "\r") {
      if (text[i + 1] === "\n") i++;
      starts.push(i + 1);
      continue;
    }
    if (character === "\n" || character === "\u2028" || character === "\u2029") starts.push(i + 1);
  }
  return starts;
}

/** Converts an absolute UTF-16 offset to a zero-based line and column. */
function offsetPosition(offset: number, starts: number[]): { line: number; column: number } {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= offset) low = middle;
    else high = middle;
  }
  return { line: low, column: offset - starts[low] };
}

/** Maps an offset from pre-edit text into post-edit text. */
function transformForward(offset: number, edits: TextEdit[]): number {
  let delta = 0;
  for (const edit of edits) {
    if (offset < edit.start) break;
    if (offset < edit.end) return edit.start + delta;
    delta += edit.replacement.length - (edit.end - edit.start);
  }
  return offset + delta;
}

/** Maps an offset from post-edit text back into pre-edit text. */
function transformBackward(offset: number, edits: TextEdit[]): number {
  let delta = 0;
  for (const edit of edits) {
    const start = edit.start + delta;
    const end = start + edit.replacement.length;
    if (offset < start) break;
    if (offset < end) return edit.start;
    delta += edit.replacement.length - (edit.end - edit.start);
  }
  return offset - delta;
}

/** Sorts remapped segments and removes duplicate generated columns. */
function normalizeMappings(mappings: SourceMapMappings): SourceMapMappings {
  for (let index = 0; index < mappings.length; index++) {
    const line = mappings[index] ?? (mappings[index] = []);
    line.sort((a, b) => a[0] - b[0]);
    let write = 0;
    for (const segment of line) {
      if (write > 0 && line[write - 1][0] === segment[0]) continue;
      line[write++] = segment as SourceMapSegment;
    }
    line.length = write;
  }
  return mappings;
}

/** The trailing comment omitted by `deno transpile` for separate maps. */
export function sourceMappingComment(mapName: string): string {
  return `//# sourceMappingURL=${mapName}\n`;
}
