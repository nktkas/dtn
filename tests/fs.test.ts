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

Deno.test("moveEmitted", async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "dtn-fs-" });
  try {
    await t.step("moves a file into place, creating parent directories", async () => {
      await Deno.writeTextFile(join(dir, "a.js"), "x");
      await fs.moveEmitted(join(dir, "a.js"), join(dir, "deep/nested/a.js"));
      assertEquals(await Deno.readTextFile(join(dir, "deep/nested/a.js")), "x");
    });

    await t.step("a missing artifact is a broken emission contract: TRANSPILE_FAILED", async () => {
      const e = await assertRejects(() => fs.moveEmitted(join(dir, "missing.js"), join(dir, "out.js")), BuildError);
      assertEquals(e.code, "TRANSPILE_FAILED");
      assertEquals(e.subject, join(dir, "missing.js"));
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
