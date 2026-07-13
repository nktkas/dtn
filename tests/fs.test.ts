// deno-lint-ignore-file no-import-prefix

/**
 * Unit tests for the file-system helpers of `src/fs.ts`.
 *
 * @module
 */

import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@^1";
import { BuildError } from "../src/errors.ts";
import * as fs from "../src/fs.ts";

Deno.test("moveEmitted classifies a missing artifact as EMIT_FAILED", async () => {
  const dir = await Deno.makeTempDir({ prefix: "dtn-fs-" });
  try {
    const e = await assertRejects(() => fs.moveEmitted(join(dir, "missing.js"), join(dir, "out.js")), BuildError);
    assertEquals(e.code, "EMIT_FAILED");
    assertEquals(e.subject, join(dir, "missing.js"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stripGeneratedAmdDirective removes an absolute AMD name after leading trivia", async () => {
  const dir = await Deno.makeTempDir({ prefix: "dtn-fs-" });
  try {
    const path = join(dir, "mod.d.ts");
    const expected = `/** Module documentation. */\n// Retained compiler trivia.\n\nexport declare const value: 1;\n`;
    await Deno.writeTextFile(
      path,
      `/** Module documentation. */\n// Retained compiler trivia.\n\n` +
        `/// <amd-module name="file:///tmp/project/mod.ts" />\nexport declare const value: 1;\n`,
    );

    await fs.stripGeneratedAmdDirective(path);

    assertEquals(await Deno.readTextFile(path), expected);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
