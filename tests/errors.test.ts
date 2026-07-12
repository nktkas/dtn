// deno-lint-ignore-file no-import-prefix

/**
 * Unit tests for the `BuildError` subject and cause contract.
 *
 * @module
 */

import { assertEquals, assertStrictEquals } from "jsr:@std/assert@1";
import { BuildError } from "../src/errors.ts";

Deno.test("BuildError appends the subject and preserves the original cause", () => {
  const cause = new Error("cache failed");
  const error = new BuildError("DEPENDENCY_FAILED", "cannot load module", {
    subject: "jsr:@x/y",
    cause,
  });
  assertEquals(error.subject, "jsr:@x/y");
  assertEquals(error.message, "cannot load module (jsr:@x/y)");
  assertStrictEquals(error.cause, cause);
});
