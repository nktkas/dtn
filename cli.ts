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
import { dirname, resolve } from "@std/path";
import { BuildError } from "./src/errors.ts";
import { type DenoConfig, SOURCE_MAP_MODES } from "./src/intake.ts";

// deno-fmt-ignore
const USAGE = `${bold("dtn")} — build a Deno project into a publish-ready npm package.

${bold("Usage:")} deno run -A jsr:@nktkas/dtn/cli [options]

${bold("Options:")}
  ${cyan("--out-dir")} ${gray("<dir>")}                      Output directory (default: dist).
  ${cyan("--deno-json")} ${gray("<path>")}                   deno.json to read the package facts from (default: deno.json); its directory is the project root.
  ${cyan("--replace")} ${gray("<alias=name>")}               Replace an import-map alias with an npm package. Repeatable.
  ${cyan("--copy")} ${gray("<file>")}                        Copy a project-root file verbatim into the package root. Repeatable.
  ${cyan("--source-map")} ${gray(`<${SOURCE_MAP_MODES.join("|")}>`)}  Source-map output (default: separate).
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

  const sourceMapFlag = flags["source-map"];
  const sourceMap = SOURCE_MAP_MODES.find((m) => m === sourceMapFlag);
  if (sourceMapFlag !== undefined && sourceMap === undefined) {
    throw new Error(`--source-map must be one of: ${SOURCE_MAP_MODES.join(", ")}`);
  }

  const npmReplacements: Record<string, string> = {};
  for (const pair of flags.replace) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`--replace expects "alias=name", got "${pair}"`);
    npmReplacements[pair.slice(0, eq)] = pair.slice(eq + 1);
  }

  const configPath = flags["deno-json"] ?? "deno.json";
  const denoJson = JSON.parse(await Deno.readTextFile(configPath)) as DenoConfig;

  // Imported lazily so `--help` and argument errors do not load the engine (and its native oxc-parser).
  const { build } = await import("./mod.ts");
  await build({
    root: dirname(resolve(configPath)),
    outDir: resolve(flags["out-dir"] ?? "dist"),
    denoJson,
    npmReplacements,
    copyFiles: flags.copy,
    sourceMap,
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
