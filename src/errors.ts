/** Machine-readable cause of a build failure. */
export type BuildErrorCode =
  | "INVALID_EXPORTS"
  | "REPLACEMENT_ALIAS_UNKNOWN"
  | "REPLACEMENT_TARGET_INVALID"
  | "REPLACEMENT_DIRECT_IMPORT"
  | "UNSUPPORTED_LOCAL_SOURCE"
  | "UNSUPPORTED_VENDORED_DEPENDENCY"
  | "UNRESOLVED_SPECIFIER"
  | "MODULE_LOAD_FAILED"
  | "TRANSPILE_FAILED"
  | "REWRITE_PARSE_FAILED";

/**
 * A build failure raised by the engine, with a machine-readable {@linkcode code} and, when known, a
 * {@linkcode subject} (the offending file path or specifier).
 *
 * @example
 * ```ts ignore
 * try {
 *   await build(config);
 * } catch (e) {
 *   if (e instanceof BuildError && e.code === "REPLACEMENT_ALIAS_UNKNOWN") { ... }
 * }
 * ```
 */
export class BuildError extends Error {
  override readonly name = "BuildError";
  readonly code: BuildErrorCode;
  readonly subject?: string;

  constructor(code: BuildErrorCode, message: string, subject?: string) {
    super(subject === undefined ? message : `${message} (${subject})`);
    this.code = code;
    this.subject = subject;
  }
}
