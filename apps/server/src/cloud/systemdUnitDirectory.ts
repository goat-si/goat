import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";

const decodeSystemdUnitPaths = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ data: Schema.Array(Schema.String) })),
);

// The manager may not share the installer's environment; JSON preserves spaces in its paths.
export const readSystemdUnitDirectory = Effect.fn("cloud.boot_service.read_systemd_unit_directory")(
  function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    const path = yield* Path.Path;
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
    // The persistent control directory identifies the manager's config root despite UnitPath overrides.
    const controlDirectory = data.find(
      (directory) =>
        path.isAbsolute(directory) &&
        directory.endsWith("/systemd/user.control") &&
        data.includes(directory.slice(0, -".control".length)),
    );
    return controlDirectory?.slice(0, -".control".length);
  },
  Effect.orElseSucceed(() => undefined),
);
