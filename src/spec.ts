/**
 * Parsing and rewriting helpers for module specifiers and package-relative paths.
 *
 * @module
 */

import { dirname, relative } from "@std/path";

// =============================================================================
// Registry specifiers
// =============================================================================

/** Matches `scheme:[/]name[@version][/subpath]`. The package name may be unscoped or use `@scope/name`. */
const REGISTRY_SPECIFIER = /^(npm|jsr):\/?(@[^/]+\/[^@/]+|[^@/]+)(?:@([^/]+))?(\/.*)?$/;

/**
 * A parsed `npm:`/`jsr:` specifier.
 *
 * @see https://docs.deno.com/runtime/fundamentals/node/#using-npm-packages
 * @see https://docs.deno.com/runtime/fundamentals/modules/
 * @see https://jsr.io/docs/using-packages#importing-with-jsr-specifiers
 */
interface ParsedSpecifier {
  scheme: "npm" | "jsr";
  pkg: string;
  version?: string;
  subpath: string;
}

/**
 * Parses an `npm:`/`jsr:` specifier `scheme:[/]name[@version][/subpath]`, or returns `null` when `spec` is neither.
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
 *
 * @see https://docs.deno.com/runtime/fundamentals/node/#using-npm-packages
 * @see https://docs.deno.com/runtime/fundamentals/modules/
 * @see https://jsr.io/docs/using-packages#importing-with-jsr-specifiers
 */
export function parseRegistry(spec: string): ParsedSpecifier | null {
  const m = spec.match(REGISTRY_SPECIFIER);
  return m ? { scheme: m[1] as "npm" | "jsr", pkg: m[2], version: m[3], subpath: m[4] ?? "" } : null;
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
export function parseReplacement(value: string): { name: string; version?: string } | null {
  const m = value.match(/^(@[^/@]+\/[^/@]+|[^/@]+)(?:@(.+))?$/);
  return m === null ? null : { name: m[1], version: m[2] };
}

// =============================================================================
// Package paths
// =============================================================================

/** True for `./x` and `../x` relative specifiers. */
export function isRelative(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../");
}

/**
 * The portable package-relative source path of one vendored URL and media type.
 *
 * @example
 * ```ts
 * vendoredRel("https://jsr.io/@std/encoding/1.0.0/hex.ts", "_deps", "TypeScript");
 * // -> "_deps/h-jsr~2eio/p-~40std/p-encoding/p-1~2e0~2e0/p-hex~2ets/mod.ts"
 * ```
 */
export function vendoredRel(
  url: string,
  depsDir: string,
  media: "TypeScript" | "Mts" | "JavaScript" | "Mjs" | "Dts" | "Dmts" | "Dcts" | "Json",
): string {
  const u = new URL(url);
  const segments = portableComponents("h", u.host);
  const pathname = u.pathname.startsWith("/") ? u.pathname.slice(1) : u.pathname;
  for (const segment of pathname.split("/")) segments.push(...portableComponents("p", segment));
  if (u.search !== "") segments.push(...portableComponents("q", u.search.slice(1)));
  if (u.hash !== "") segments.push(...portableComponents("f", u.hash.slice(1)));

  let extension = ".js";
  if (media === "TypeScript") extension = ".ts";
  if (media === "Mts") extension = ".mts";
  if (media === "Mjs") extension = ".mjs";
  if (media === "Dts") extension = ".d.ts";
  if (media === "Dmts") extension = ".d.mts";
  if (media === "Dcts") extension = ".d.cts";
  if (media === "Json") extension = ".json";
  return `${depsDir}/${segments.join("/")}/mod${extension}`;
}

/** Splits one encoded URL component below common filesystem component limits without losing segment boundaries. */
function portableComponents(prefix: "h" | "p" | "q" | "f", value: string): string[] {
  const encoded = portableSegment(value);
  const components = [`${prefix}-${encoded.slice(0, 120)}`];
  for (let offset = 120; offset < encoded.length; offset += 120) {
    components.push(`c-${encoded.slice(offset, offset + 120)}`);
  }
  return components;
}

/** Encodes one URL segment using only lowercase, case-stable portable filename bytes. */
function portableSegment(value: string): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length === 0) return "~";

  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    const safe = (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39) || byte === 0x2d || byte === 0x5f;
    out += safe ? String.fromCharCode(byte) : `~${byte.toString(16).padStart(2, "0")}`;
  }
  return out;
}

/**
 * Swaps a trailing `.ts`/`.mts` for `.js`/`.mjs` (a no-op for any other extension).
 *
 * Matches source extensions literally, so callers must exclude declaration paths.
 */
export function tsToJs(path: string): string {
  if (path.endsWith(".mts")) return `${path.slice(0, -4)}.mjs`;
  return path.endsWith(".ts") ? `${path.slice(0, -3)}.js` : path;
}

/** The declaration sidecar emitted for a JavaScript or MJS module, or `null` for any other path. */
export function jsToDts(path: string): string | null {
  if (path.endsWith(".mjs")) return `${path.slice(0, -4)}.d.mts`;
  if (path.endsWith(".js")) return `${path.slice(0, -3)}.d.ts`;
  return null;
}

/** Rewrites OS path separators to POSIX, the form used for every specifier and `package.json` path. */
export function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
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

// =============================================================================
// Import-map resolution
// =============================================================================

/**
 * Resolves a specifier using Deno import-map precedence:
 * - An exact alias.
 * - The longest matching prefix.
 * - Plain URL resolution.
 *
 * @example
 * ```ts
 * const resolve = makeResolver({ "@std/encoding": "jsr:@std/encoding@^1" });
 * resolve("@std/encoding/hex", "file:///repo/mod.ts");
 * // -> "jsr:@std/encoding@^1/hex"  (longest-prefix match, the remaining subpath appended)
 * ```
 *
 * @see https://html.spec.whatwg.org/multipage/webappapis.html#import-maps
 * @see https://docs.deno.com/runtime/fundamentals/modules/
 */
export function makeResolver(imports: Record<string, string>): (specifier: string, referrer: string) => string {
  // Deno's deno.json imports extend import maps by treating package aliases without a trailing slash as prefixes.
  const prefixes = Object.keys(imports).sort((a, b) => b.length - a.length);
  return (specifier, referrer) => {
    if (Object.hasOwn(imports, specifier)) return imports[specifier];
    for (const key of prefixes) {
      const boundary = key.endsWith("/") ? key : `${key}/`;
      if (specifier.startsWith(boundary)) return imports[key] + specifier.slice(key.length);
    }
    if (isRelative(specifier) || specifier.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(specifier)) {
      return new URL(specifier, referrer).href;
    }
    return specifier;
  };
}
