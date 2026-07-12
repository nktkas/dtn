// deno-lint-ignore-file no-import-prefix

/**
 * Unit tests for the `BuildError` category, subject, and cause contract.
 *
 * @module
 */

import { assertEquals, assertStrictEquals } from "jsr:@std/assert@1";
import { BuildError } from "../src/errors.ts";

Deno.test("BuildError", async (t) => {
  await t.step("stores a broad category and message", () => {
    const error = new BuildError("INVALID_CONFIG", "no exports to build from");
    assertEquals(error.code, "INVALID_CONFIG");
    assertEquals(error.subject, undefined);
    assertEquals(error.message, "no exports to build from");
  });

  await t.step("appends the subject and preserves the original cause", () => {
    const cause = new Error("cache failed");
    const error = new BuildError("DEPENDENCY_FAILED", "cannot load module", {
      subject: "jsr:@x/y",
      cause,
    });
    assertEquals(error.subject, "jsr:@x/y");
    assertEquals(error.message, "cannot load module (jsr:@x/y)");
    assertStrictEquals(error.cause, cause);
  });
});
