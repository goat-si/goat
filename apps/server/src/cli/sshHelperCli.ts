import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Stdio from "effect/Stdio";
import { Command } from "effect/cli";

import packageJson from "../../package.json" with { type: "json" };
import { sshHelperCommand } from "./sshHelper.ts";

/**
 * What SSH probes and launches start goat for: `--version` and `__ssh-helper`. Loading only these
 * skips the full CLI's module graph, which costs seconds per start on a slow host.
 */
const sshHelperCli = Command.make("goat").pipe(Command.withSubcommands([sshHelperCommand]));

export const runSshHelperCliWithArgs = (args: ReadonlyArray<string>) =>
  Command.runWith(sshHelperCli, { version: packageJson.version })(args);

export function runSshHelperCli() {
  Stdio.Stdio.use(({ args }) => Effect.flatMap(args, runSshHelperCliWithArgs)).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
