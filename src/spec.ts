/**
 * Parsing and rewriting helpers for module specifiers and package-relative paths.
 *
 * @module
 */

import { dirname, relative } from "@std/path";

// ── Registry specifiers ─────────────────────────────────────────────────────

/**
 * Matches a registry specifier `scheme:[/]name[@version][/subpath]`; the name group accepts an unscoped name
 * or `@scope/name`.
 */
const REGISTRY_SPECIFIER = /^(npm|jsr):\/?(@[^/]+\/[^@/]+|[^@/]+)(?:@([^/]+))?(\/.*)?$/;
const JSR_URL = /^https:\/\/jsr\.io\/(@[^/]+\/[^/]+)\//;

/** A parsed `npm:`/`jsr:` specifier. */
interface ParsedSpecifier {
  scheme: "npm" | "jsr";
  pkg: string;
  version?: string;
  subpath: string;
}

/**
 * Parses an `npm:`/`jsr:` specifier `scheme:[/]name[@version][/subpath]`, or `null` when `spec` is neither.
 *
 * @example
 * ```ts
 * parseRegistry("npm:chalk@^5");
 * // -> { scheme: "npm", pkg: "chalk", version: "^5", subpath: "" }
 * parseRegistry("jsr:@std/encoding@1/hex");
 * // -> { scheme: "jsr", pkg: "@std/encoding", version: "1", subpath: "/hex" }
 * parseRegistry("node:fs");
 * // -> null  (not a package-registry scheme)
 * ```
 */
export function parseRegistry(spec: string): ParsedSpecifier | null {
  const m = spec.match(REGISTRY_SPECIFIER);
  return m ? { scheme: m[1] as "npm" | "jsr", pkg: m[2], version: m[3], subpath: m[4] ?? "" } : null;
}

/** The jsr package (`@scope/name`) of a `https://jsr.io/...` module URL, or `null` for any other URL. */
export function jsrUrlPackage(url: string): string | null {
  return url.match(JSR_URL)?.[1] ?? null;
}

/**
 * Splits an npm replacement value `name[@version]` into the package name and optional version range.
 *
 * @example
 * ```ts
 * parseReplacement("valibot@^1");
 * // -> { name: "valibot", version: "^1" }
 * parseReplacement("@scope/pkg");
 * // -> { name: "@scope/pkg", version: undefined }
 * ```
 */
export function parseReplacement(value: string): { name: string; version?: string } {
  const m = value.match(/^(@?[^@]+)(?:@(.+))?$/);
  return m === null ? { name: value } : { name: m[1], version: m[2] };
}

// ── Package paths ───────────────────────────────────────────────────────────

/** True for `./x` and `../x` relative specifiers. */
export function isRelative(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../");
}

/**
 * The package-relative path of a vendored module under {@linkcode depsDir}, mirroring its remote URL.
 *
 * @example
 * ```ts
 * vendoredRel("https://jsr.io/@std/encoding/1.0.0/hex.ts", "_deps");
 * // -> "_deps/jsr.io/@std/encoding/1.0.0/hex.ts"  (a URL query string, if any, is dropped)
 * ```
 */
export function vendoredRel(url: string, depsDir: string): string {
  const u = new URL(url);
  return `${depsDir}/${u.host}${u.pathname}`;
}

/**
 * Swaps a trailing `.ts` for `.js` (a no-op for any other extension).
 *
 * Matches the literal `.ts`, so `.d.ts` -> `.d.js` — callers must exclude declaration paths.
 */
export function tsToJs(path: string): string {
  return path.endsWith(".ts") ? `${path.slice(0, -3)}.js` : path;
}

/** Swaps a trailing `.js` for `.ts` (a no-op for any other extension). */
export function jsToTs(path: string): string {
  return path.endsWith(".js") ? `${path.slice(0, -3)}.ts` : path;
}

/** Rewrites OS path separators to POSIX, the form used for every specifier and `package.json` path. */
export function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * The concrete export subpath for a file matched by a wildcard export: the file's `*` capture, substituted into the
 * subpath pattern.
 *
 * @example
 * ```ts
 * wildcardSubpath("./*", "./src/*.ts", "./src/a.ts");
 * // -> "./a"
 * wildcardSubpath("./*", "./src/*.ts", "./src/types.d.ts");
 * // -> "./types.d"  (`*.ts` captures `types.d`)
 * ```
 */
export function wildcardSubpath(subpathPattern: string, sourcePattern: string, source: string): string {
  const [prefix, suffix] = sourcePattern.split("*");
  const capture = source.slice(prefix.length, source.length - suffix.length);
  return subpathPattern.replace("*", capture);
}

/**
 * A `./`- or `../`-prefixed specifier from one package file to another, both given as package-relative POSIX paths.
 *
 * @example
 * ```ts
 * relSpecifier("api/client.js", "_deps/jsr.io/@std/x/1.0.0/mod.js");
 * // -> "../_deps/jsr.io/@std/x/1.0.0/mod.js"
 * ```
 */
export function relSpecifier(fromFileRel: string, toFileRel: string): string {
  const out = toPosix(relative(dirname(fromFileRel), toFileRel));
  return isRelative(out) ? out : `./${out}`;
}

// ── Import-map resolution ───────────────────────────────────────────────────

/**
 * Deno import-map resolution: an exact alias, then the longest matching prefix, then plain URL resolution.
 *
 * A relative import-map target (`"$u": "./util.ts"`) resolves against {@linkcode base} — the import map's own URL
 * (`deno.json`) — not the referrer, so the same alias resolves to the same file from anywhere in the project.
 *
 * @example
 * ```ts
 * const resolve = makeResolver(
 *   { "@std/encoding": "jsr:@std/encoding@^1", "$u": "./util.ts" },
 *   "file:///repo/deno.json",
 * );
 * resolve("@std/encoding/hex", "file:///repo/mod.ts");
 * // -> "jsr:@std/encoding@^1/hex"  (longest-prefix match, the remaining subpath appended)
 * resolve("$u", "file:///repo/src/mod.ts");
 * // -> "file:///repo/util.ts"  (relative target resolved against the deno.json base, not the referrer)
 * ```
 */
export function makeResolver(
  imports: Record<string, string>,
  base: string,
): (specifier: string, referrer: string) => string {
  // Longest prefix first, so `@std/encoding/hex` wins over `@std/encoding`.
  const prefixes = Object.keys(imports).sort((a, b) => b.length - a.length);
  const target = (value: string): string => isRelative(value) ? new URL(value, base).href : value;
  return (specifier, referrer) => {
    const exact = imports[specifier];
    if (exact !== undefined) return target(exact);
    for (const key of prefixes) {
      const prefix = key.endsWith("/") ? key : `${key}/`;
      // Slice at key.length, not prefix.length, so the alias's boundary `/` is kept in the rewritten specifier.
      if (specifier.startsWith(prefix)) return target(imports[key] + specifier.slice(key.length));
    }
    return new URL(specifier, referrer).href;
  };
}
