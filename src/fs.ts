/**
 * File-system helpers and the `deno transpile` subprocess.
 *
 * @module
 */

import { copy, ensureDir, exists, walk } from "@std/fs";
import { dirname } from "@std/path";
import { BuildError } from "./errors.ts";

export { exists };

// ── File system ──────────────────────────────────────────────────────────────

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

/** Moves a file into place, creating parent directories; a no-op when the source does not exist. */
export async function moveIfExists(from: string, to: string): Promise<void> {
  if (!await exists(from)) return;
  await ensureDir(dirname(to));
  await Deno.rename(from, to);
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

// ── Subprocess ───────────────────────────────────────────────────────────────

/** Options for one `deno transpile` invocation. */
interface TranspileOptions {
  importMap: string;
  files: string[];
  outDir: string;
  cwd: string;
  sourceMap: "inline" | "separate" | "none";
}

/**
 * Runs `deno transpile`, emitting `.js`, source maps (inline, separate, or none), and type-checked `.d.ts` for `files`.
 *
 * @throws {BuildError} `TRANSPILE_FAILED` when the `deno transpile` subprocess exits non-zero (e.g. a type error).
 */
export async function transpile(options: TranspileOptions): Promise<void> {
  try {
    await run("deno", [
      "transpile",
      "--import-map",
      options.importMap,
      "--declaration",
      "--source-map",
      options.sourceMap,
      "--outdir",
      options.outDir,
      ...options.files,
    ], options.cwd);
  } catch (e) {
    throw new BuildError("TRANSPILE_FAILED", e instanceof Error ? e.message : String(e));
  }
}

/** Spawns `cmd` in `cwd`; rejects with the captured output on a non-zero exit. */
async function run(cmd: string, args: string[], cwd: string): Promise<void> {
  const { code, stdout, stderr } = await new Deno.Command(cmd, { args, cwd, stdout: "piped", stderr: "piped" })
    .output();
  if (code !== 0) {
    const dec = new TextDecoder();
    const detail = [dec.decode(stdout), dec.decode(stderr)].filter((s) => s.length > 0).join("\n");
    throw new Error(`${cmd} ${args.join(" ")} exited with ${code}\n${detail}`);
  }
}
