import * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

/**
 * Pi's driver starts from its launch descriptor, so each turn tells the extension through this
 * file whether it may use it: "on" keeps the launch driver, "driver" names the current one in a
 * file beside it (a real driver change), "off" closes it (a Plan or read-only
 * turn). An extension from an older build treats "driver" as closed. Another file beside it says
 * whether the turn carries the computer use skill.
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
    Effect.forEach([`${path}.skill`, `${path}.driver`], (file) =>
      fileSystem.remove(file, { force: true }).pipe(Effect.ignore),
    ),
  );
  return path;
});

const gateValue = (
  gate: PiCuaGate,
  driver: McpProviderSession.McpProviderSessionConfig["cuaDriver"],
) =>
  driver === undefined
    ? "off"
    : McpProviderSession.cuaDriverKey(driver) === gate.key
      ? "on"
      : "driver";

/** Written before the prompt, so the extension reads it in before_agent_start. */
export const writePiCuaGate = (
  fileSystem: FileSystem.FileSystem,
  gate: PiCuaGate,
  attached: McpProviderSession.McpProviderSessionConfig | undefined,
) =>
  (attached?.cuaDriver === undefined
    ? Effect.void
    : fileSystem.writeFileString(
        `${gate.path}.driver`,
        // The shape the launch environment carries (GOAT_CUA_MCP), which the extension parses.
        JSON.stringify({
          command: attached.cuaDriver.command,
          args: attached.cuaDriver.args,
          env: Object.fromEntries(
            attached.cuaDriver.environment.map(({ name, value }) => [name, value]),
          ),
        }),
      )
  )
    .pipe(
      Effect.andThen(fileSystem.writeFileString(gate.path, gateValue(gate, attached?.cuaDriver))),
    )
    .pipe(
      Effect.andThen(
        fileSystem.writeFileString(
          `${gate.path}.skill`,
          McpProviderSession.carriesComputerUseSkill(attached) ? "on" : "off",
        ),
      ),
    );
