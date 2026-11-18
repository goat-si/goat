import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";
import { systemdUnitDirectoryOf } from "./systemdValues.ts";

const decodeSystemdUnitPaths = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ data: Schema.Array(Schema.String) })),
);

export function defaultSystemdUnitDirectory(path: Path.Path, home: string, xdgConfigHome: string) {
  return path.join(
    path.isAbsolute(xdgConfigHome) ? xdgConfigHome : path.join(home, ".config"),
    "systemd",
    "user",
  );
}

// The manager may not share the installer's environment; JSON preserves spaces in its paths.
export const readSystemdUnitDirectory = Effect.fn("cloud.boot_service.read_systemd_unit_directory")(
  function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    const result = yield* runner.run({
      command: "busctl",
      args: [
        "--user",
        "--json=short",
        "get-property",
        "org.freedesktop.systemd1",
        "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager",
        "UnitPath",
      ],
      timeout: Duration.seconds(5),
    });
    if (result.code !== 0) return undefined;
    const { data } = yield* decodeSystemdUnitPaths(result.stdout);
    return systemdUnitDirectoryOf(data);
  },
  Effect.orElseSucceed(() => undefined),
);
