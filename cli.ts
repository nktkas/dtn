/**
 * Command-line entry for `build()`: reads `deno.json` and turns the project into an npm package.
 *
 * @example
 * ```sh
 * deno run -A jsr:@nktkas/dtn/cli --out-dir dist --replace @valibot/valibot=valibot --copy README.md --copy LICENSE
 * ```
 *
 * @module
 */

import { parseArgs } from "@std/cli/parse-args";
import { bold, cyan, gray } from "@std/fmt/colors";
import { BuildError } from "./src/errors.ts";
import type { DenoConfig } from "./src/intake.ts";

// deno-fmt-ignore
const USAGE = `${bold("dtn")} — build a Deno project into a publish-ready npm package.

${bold("Usage:")} deno run -A jsr:@nktkas/dtn/cli [options]

${bold("Options:")}
  ${cyan("--out-dir")} ${gray("<dir>")}                      Output directory (default: dist).
  ${cyan("--deno-json")} ${gray("<path>")}                   deno.json to read the package facts from (default: deno.json).
  ${cyan("--replace")} ${gray("<alias=name>")}               Replace an import-map alias with an npm package. Repeatable.
  ${cyan("--copy")} ${gray("<file>")}                        Copy a file verbatim into the package root. Repeatable.
  ${cyan("--source-map")} ${gray("<separate|inline|none>")}  Source-map output (default: separate).
  ${cyan("--deps-dir")} ${gray("<dir>")}                     Folder under the code root for inlined dependencies (default: _deps).
  ${cyan("-h, --help")}                           Show this help.`;

/** Parses {@linkcode args}, reads the `deno.json` they point at, and runs the build. */
export async function run(args: string[]): Promise<void> {
  const flags = parseArgs(args, {
    string: ["out-dir", "deno-json", "source-map", "deps-dir", "replace", "copy"],
    boolean: ["help"],
    collect: ["replace", "copy"],
    alias: { h: "help" },
  });

  if (flags.help) {
    console.log(USAGE);
    return;
  }

  const sourceMap = flags["source-map"];
  if (sourceMap !== undefined && !["separate", "inline", "none"].includes(sourceMap)) {
    throw new Error("--source-map must be one of: separate, inline, none");
  }

  const npmReplacements: Record<string, string> = {};
  for (const pair of flags.replace) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`--replace expects "alias=name", got "${pair}"`);
    npmReplacements[pair.slice(0, eq)] = pair.slice(eq + 1);
  }

  const denoJson = JSON.parse(await Deno.readTextFile(flags["deno-json"] ?? "deno.json")) as DenoConfig;

  // Imported lazily so `--help` and argument errors do not load the engine (and its native oxc-parser).
  const { build } = await import("./mod.ts");
  await build({
    outDir: flags["out-dir"] ?? "dist",
    denoJson,
    npmReplacements,
    copyFiles: flags.copy,
    sourceMap: sourceMap as "separate" | "inline" | "none" | undefined,
    depsDir: flags["deps-dir"],
  });
}

if (import.meta.main) {
  try {
    await run(Deno.args);
  } catch (e) {
    const detail = e instanceof BuildError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
    console.error(`dtn: ${detail}`);
    Deno.exit(1);
  }
}
