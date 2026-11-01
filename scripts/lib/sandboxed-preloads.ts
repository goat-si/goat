import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** The sandboxed preload bundles in apps/desktop/dist-electron (see apps/desktop/vite.config.ts). */
export const SANDBOXED_PRELOADS = [
  "preload.cjs",
  "preview-pick-preload.cjs",
  "preview-pip-preload.cjs",
  "mac-permission-preload.cjs",
] as const;

// The parameters Electron's sandbox wraps around a preload's source.
const SANDBOXED_PRELOAD_PARAMETERS = [
  "require",
  "process",
  "Buffer",
  "global",
  "setImmediate",
  "clearImmediate",
  "exports",
  "module",
] as const;

/** Why Electron's sandbox would refuse this preload source, or undefined when it parses. */
export function sandboxedPreloadSyntaxError(source: string): string | undefined {
  try {
    // Parses only: the function is never called.
    Function(...SANDBOXED_PRELOAD_PARAMETERS, source);
    return undefined;
  } catch (error) {
    return error instanceof SyntaxError ? error.message : undefined;
  }
}

export class SandboxedPreloadInvalidError extends Schema.TaggedError<SandboxedPreloadInvalidError>()(
  "SandboxedPreloadInvalidError",
  { problems: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return [
      "Electron's sandbox cannot load these preload bundles:",
      ...this.problems.map((problem) => "  - " + problem),
    ].join("\n");
  }
}

export const validateSandboxedPreloads = Effect.fn(
  "build-desktop-artifact.validateSandboxedPreloads",
)(function* (desktopDist: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const problems: string[] = [];
  for (const name of SANDBOXED_PRELOADS) {
    const problem = sandboxedPreloadSyntaxError(
      yield* fs.readFileString(path.join(desktopDist, name)),
    );
    if (problem !== undefined) problems.push(name + ": " + problem);
  }
  if (problems.length > 0) return yield* new SandboxedPreloadInvalidError({ problems });
});
