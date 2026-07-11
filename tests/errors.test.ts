// deno-lint-ignore-file no-import-prefix

/**
 * Unit tests for the `BuildError` message and subject contract.
 *
 * @module
 */

import { assertEquals } from "jsr:@std/assert@1";
import { BuildError } from "../src/errors.ts";

Deno.test("BuildError", async (t) => {
  await t.step("stores code and message without a subject", () => {
    const e = new BuildError("INVALID_EXPORTS", "no exports to build from");
    assertEquals(e.code, "INVALID_EXPORTS");
    assertEquals(e.subject, undefined);
    assertEquals(e.message, "no exports to build from");
  });

  await t.step("appends the subject to the message in parentheses", () => {
    const e = new BuildError("UNRESOLVED_SPECIFIER", "specifier resolves to nothing", "jsr:@x/y");
    assertEquals(e.code, "UNRESOLVED_SPECIFIER");
    assertEquals(e.subject, "jsr:@x/y");
    assertEquals(e.message, "specifier resolves to nothing (jsr:@x/y)");
  });
});
