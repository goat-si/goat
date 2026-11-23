import { AcpRegistryOperationError } from "@goat/contracts";
import type * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const isolateDeepSeekProbeHistory = Effect.fn(
  "AcpRegistryProbe.isolateDeepSeekProbeHistory",
)(
  function* (commandPath: string, spawn: AcpSessionRuntime.AcpSpawnInput) {
    const executable = (commandPath || spawn.command).split(/[\\/]/u).at(-1) ?? "";
    if (!/^dsh(?:\.cmd|\.exe)?$/iu.test(executable)) return spawn;

    const argumentSeparator = spawn.args.indexOf("--");
    const launcherArgs =
      argumentSeparator === -1 ? spawn.args : spawn.args.slice(0, argumentSeparator);
    const usesAcpProfile =
      launcherArgs[0] === "acp" ||
      launcherArgs.includes("--profile=acp") ||
      launcherArgs.some((arg, index) => arg === "--profile" && launcherArgs[index + 1] === "acp");
    if (!usesAcpProfile) return spawn;

    // DeepSeek persists session/new before any prompt and does not advertise session/delete.
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-dsh-acp-probe-" });
    const patchPath = path.join(directory, "probe.json");
    const patch = yield* encodeJson([
      { id: "session-persistence-jsonl", config: { root: path.join(directory, "sessions") } },
      { id: "session-projection-cache", disabled: true },
    ]);
    yield* fs.writeFileString(patchPath, patch);
    return {
      ...spawn,
      args: [...launcherArgs, "--patch", patchPath, ...spawn.args.slice(launcherArgs.length)],
    };
  },
  Effect.mapError(
    (cause) =>
      new AcpRegistryOperationError({
        reason: "probe_failed",
        message: "Could not prepare temporary history for the DeepSeek Harness probe.",
        cause,
      }),
  ),
);
