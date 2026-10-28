import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/cli";
import * as CliError from "effect/cli/CliError";
import { FetchHttpClient } from "effect/http";

import * as Installation from "../opencodex/OpenCodexInstallation.ts";
import * as ProcessRunner from "../processRunner.ts";

/**
 * `goat opencodex install`: the OS user's own request to install GOAT's pinned OpenCodex. It
 * reads no GOAT settings or database and starts no server, so a provisioned runtime can run it.
 */
const install = Command.make("install", {
  printPath: Flag.Boolean("print-path").pipe(
    Flag.withDescription("Print only the selected ocx path."),
    Flag.withDefault(false),
  ),
  managedVersion: Flag.String("managed-version").pipe(
    Flag.withDescription("Replace a GOAT-managed install with this pinned release."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Install GOAT-tested OpenCodex without Node or npm. Keeps a supported existing install; does not join a Home.",
  ),
  Command.withHandler(
    Effect.fn("cli.opencodex.install")(
      function* (flags) {
        const service = yield* Installation.OpenCodexInstallation;
        const managedVersion = Option.getOrUndefined(flags.managedVersion);
        const executable = yield* service
          .install(managedVersion === undefined ? {} : { managedVersion })
          .pipe(Effect.mapError((error) => new CliError.UserError({ cause: error.message })));
        yield* Console.log(
          flags.printPath
            ? executable.path
            : `OpenCodex ${executable.version} (${executable.ownership}): ${executable.path}`,
        );
      },
      Effect.provide(
        Installation.layer.pipe(
          Layer.provide(ProcessRunner.layer),
          Layer.provide(FetchHttpClient.layer),
        ),
      ),
    ),
  ),
);

export const opencodexCommand = Command.make("opencodex").pipe(
  Command.withDescription("Install the OpenCodex runtime used on this machine."),
  Command.withSubcommands([install]),
);
