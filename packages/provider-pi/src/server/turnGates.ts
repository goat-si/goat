import * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

import { openPiCuaGate, writePiCuaGate, type PiCuaGate } from "./cuaGate.ts";
import { openPiScreenSkillGate, writePiScreenSkillGate } from "./screenSkillGate.ts";

/** The per-session gate files Pi's extension rereads at the start of every turn. */
export interface PiTurnGates {
  readonly cua: PiCuaGate | undefined;
  readonly screenSkillPath: string | undefined;
  readonly subagentsPath: string | undefined;
}

const subagentGateValue = (session: McpProviderSession.McpProviderSessionConfig | undefined) =>
  session?.nativeSubagentLimit === 0 ? "off" : "on";

export const openPiTurnGates = Effect.fn("PiTurnGates.open")(function* (
  fileSystem: FileSystem.FileSystem,
  mcpSession: McpProviderSession.McpProviderSessionConfig | undefined,
) {
  const cua =
    mcpSession?.cuaDriver === undefined
      ? undefined
      : {
          path: yield* openPiCuaGate(fileSystem),
          key: McpProviderSession.cuaDriverKey(mcpSession.cuaDriver),
        };
  const screenSkillPath =
    mcpSession === undefined ? undefined : yield* openPiScreenSkillGate(fileSystem);
  const subagentsPath =
    mcpSession === undefined
      ? undefined
      : yield* fileSystem.makeTempFileScoped({ prefix: "goat-pi-subagents-" });
  if (subagentsPath !== undefined)
    yield* fileSystem.writeFileString(subagentsPath, subagentGateValue(mcpSession));
  return { cua, screenSkillPath, subagentsPath } satisfies PiTurnGates;
});

/** Fails with the name of the gate it could not write, for the turn's protocol error. */
export const writePiTurnGates = Effect.fn("PiTurnGates.write")(function* (
  fileSystem: FileSystem.FileSystem,
  gates: PiTurnGates,
  readAttached: Effect.Effect<McpProviderSession.McpProviderSessionConfig | undefined>,
) {
  if (
    gates.screenSkillPath === undefined &&
    gates.cua === undefined &&
    gates.subagentsPath === undefined
  )
    return;
  const attached = yield* readAttached;
  if (gates.screenSkillPath !== undefined)
    yield* writePiScreenSkillGate(fileSystem, gates.screenSkillPath, attached).pipe(
      Effect.mapError(() => "screen guide"),
    );
  if (gates.cua !== undefined)
    yield* writePiCuaGate(fileSystem, gates.cua, attached).pipe(
      Effect.mapError(() => "computer use access"),
    );
  if (gates.subagentsPath !== undefined)
    yield* fileSystem
      .writeFileString(gates.subagentsPath, subagentGateValue(attached))
      .pipe(Effect.mapError(() => "native subagent limit"));
});
