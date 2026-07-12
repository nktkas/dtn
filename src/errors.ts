/**
 * The package error contract: every failure is a {@linkcode BuildError} carrying a {@linkcode BuildErrorCode}.
 *
 * @module
 */

/** Machine-readable cause of a build failure. */
export type BuildErrorCode =
  | "INVALID_CONFIG"
  | "UNSUPPORTED_MODULE"
  | "DEPENDENCY_FAILED"
  | "EMIT_FAILED"
  | "BUILD_FAILED";

/**
 * A build failure with a stable machine-readable category and, when known, the offending file path or specifier.
 *
 * @example
 * ```ts ignore
 * try {
 *   await build(config);
 * } catch (e) {
 *   if (e instanceof BuildError && e.code === "INVALID_CONFIG") { ... }
 * }
 * ```
 */
export class BuildError extends Error {
  override readonly name = "BuildError";
  readonly code: BuildErrorCode;
  readonly subject?: string;

  /**
   * Creates one categorized build failure.
   *
   * @param code Stable failure category.
   * @param message Human-readable failure description.
   * @param options Optional offending subject and original failure.
   */
  constructor(code: BuildErrorCode, message: string, options: { subject?: string; cause?: unknown } = {}) {
    super(options.subject === undefined ? message : `${message} (${options.subject})`, { cause: options.cause });
    this.code = code;
    this.subject = options.subject;
  }
}
