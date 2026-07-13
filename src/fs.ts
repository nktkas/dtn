/**
 * File-system helpers and the `deno transpile` subprocess.
 *
 * @module
 */

import { copy, ensureDir, exists, walk } from "@std/fs";
import { dirname } from "@std/path";
import { BuildError } from "./errors.ts";

export { exists };

const DECLARATION_EXTENSIONS = [".d.ts", ".d.mts", ".d.cts"];
const GENERATED_AMD_DIRECTIVE =
  /^(#![^\r\n\u2028\u2029]*(?:\r\n|[\n\r\u2028\u2029]))?\/\/\/ <amd-module name="file:\/\/\/[^"\r\n\u2028\u2029]+" \/>[ \t]*(?:\r\n|[\n\r\u2028\u2029]|$)/;

// =============================================================================
// File system
// =============================================================================

/** Removes a path recursively, ignoring only "not found". */
export async function rmrf(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}

/** Writes text to `path`, creating parent directories. */
export async function writeText(path: string, text: string): Promise<void> {
  await ensureDir(dirname(path));
  await Deno.writeTextFile(path, text);
}

/** Writes bytes to `path`, creating parent directories. */
export async function writeBytes(path: string, bytes: Uint8Array): Promise<void> {
  await ensureDir(dirname(path));
  await Deno.writeFile(path, bytes);
}

/** Reads a file as UTF-8 text. */
export function readText(path: string): Promise<string> {
  return Deno.readTextFile(path);
}

/**
 * Moves an emitted artifact into place, creating parent directories.
 *
 * @throws {BuildError} `EMIT_FAILED` when the artifact was not emitted.
 */
export async function moveEmitted(from: string, to: string): Promise<void> {
  await ensureDir(dirname(to));
  try {
    await Deno.rename(from, to);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new BuildError("EMIT_FAILED", "transpile did not emit expected artifact", { subject: from, cause: e });
    }
    throw e;
  }
}

/** Copies a single file, creating parent directories. */
export async function copyFile(from: string, to: string): Promise<void> {
  await ensureDir(dirname(to));
  await Deno.copyFile(from, to);
}

/** Copies a file or directory tree verbatim into place. */
export async function copyPath(from: string, to: string): Promise<void> {
  await ensureDir(dirname(to));
  await copy(from, to, { overwrite: true });
}

/** Yields every file under `dir` whose path ends with one of `exts` (e.g. `.d.ts` matches `.ts`). */
export async function* walkFiles(dir: string, exts: string[]): AsyncGenerator<string> {
  for await (const entry of walk(dir, { includeDirs: false, exts })) yield entry.path;
}

// =============================================================================
// Subprocess
// =============================================================================

/**
 * Options for one `deno transpile` invocation.
 *
 * @see https://docs.deno.com/runtime/reference/cli/transpile/
 */
interface TranspileOptions {
  importMap: string;
  files: string[];
  outDir: string;
  cwd: string;
  /** `"none"` disables the subprocess's auto-discovery of `deno.json`/`deno.lock` from cwd ancestors. */
  config: "inherit" | "none";
}

/**
 * Runs `deno transpile`, emitting `.js`, separate source maps, and type-checked `.d.ts` for `files`.
 *
 * @throws {BuildError} `EMIT_FAILED` when the `deno transpile` subprocess exits non-zero.
 */
export async function transpile(options: TranspileOptions): Promise<void> {
  try {
    // The vendor output tree already contains copied declarations;
    // only files created by this subprocess are compiler-owned.
    const existingDeclarations = new Set<string>();
    if (await exists(options.outDir)) {
      for await (const path of walkFiles(options.outDir, DECLARATION_EXTENSIONS)) {
        existingDeclarations.add(path);
      }
    }

    await run(Deno.execPath(), [
      "transpile",
      ...(options.config === "none" ? ["--no-config", "--no-lock"] : []),
      "--import-map",
      options.importMap,
      "--declaration",
      "--source-map",
      "separate",
      "--outdir",
      options.outDir,
      ...options.files,
    ], options.cwd);

    // HACK:
    // Declaration emit assigns absolute file-URL AMD names to ESM modules, exposing the build path in package types.
    for await (const path of walkFiles(options.outDir, DECLARATION_EXTENSIONS)) {
      if (existingDeclarations.has(path)) continue;
      const declaration = await readText(path);
      await Deno.writeTextFile(path, declaration.replace(GENERATED_AMD_DIRECTIVE, "$1"));
    }
  } catch (e) {
    throw new BuildError("EMIT_FAILED", e instanceof Error ? e.message : String(e), { cause: e });
  }
}

/** Spawns `cmd` in `cwd`; rejects with the captured output on a non-zero exit. */
async function run(cmd: string, args: string[], cwd: string): Promise<void> {
  const { code, stdout, stderr } = await new Deno.Command(cmd, { args, cwd, stdout: "piped", stderr: "piped" })
    .output();
  if (code !== 0) {
    const dec = new TextDecoder();
    // Diagnostics first: the command echo grows with the file list and must not bury them.
    const parts = [dec.decode(stdout), dec.decode(stderr), `(${cmd} ${args.join(" ")} exited with ${code})`];
    throw new Error(parts.filter((s) => s.length > 0).join("\n"));
  }
}
