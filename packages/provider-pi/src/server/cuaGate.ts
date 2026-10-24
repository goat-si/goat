import * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

/**
 * Pi's driver is fixed at launch, so each turn tells the extension through this file whether it
 * may still use it; a Plan or read-only turn closes it before it starts. A file beside it says
 * whether the turn carries the computer use skill, so an extension from an older build keeps
 * reading the gate unchanged.
 */
export interface PiCuaGate {
  readonly path: string;
  /** `cuaDriverKey` of the driver Pi launched with. */
  readonly key: string;
}

export const openPiCuaGate = Effect.fn("PiCuaGate.open")(function* (
  fileSystem: FileSystem.FileSystem,
) {
  const path = yield* fileSystem.makeTempFileScoped({ prefix: "goat-pi-cua-" });
  yield* fileSystem.writeFileString(path, "on");
  yield* Effect.addFinalizer(() =>
    fileSystem.remove(`${path}.skill`, { force: true }).pipe(Effect.ignore),
  );
  return path;
});

/** Written before the prompt, so the extension reads it in before_agent_start. */
export const writePiCuaGate = (
  fileSystem: FileSystem.FileSystem,
  gate: PiCuaGate,
  attached: McpProviderSession.McpProviderSessionConfig | undefined,
) =>
  fileSystem
    .writeFileString(
      gate.path,
      McpProviderSession.cuaDriverKey(attached?.cuaDriver) === gate.key ? "on" : "off",
    )
    .pipe(
      Effect.andThen(
        fileSystem.writeFileString(
          `${gate.path}.skill`,
          McpProviderSession.carriesComputerUseSkill(attached) ? "on" : "off",
        ),
      ),
    );
