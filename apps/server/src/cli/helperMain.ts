import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@goat/shared/Net";
import * as Effect from "effect/Effect";
import { Command } from "effect/cli";
import packageJson from "../../package.json" with { type: "json" };

export function runVersionMain() {
  Command.runWith(Command.make("goat"), { version: packageJson.version })(["--version"]).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}

export async function runSshHelperMain(args: ReadonlyArray<string>) {
  const { sshHelperCommand } = await import("./sshHelper.ts");
  const { sharedServerCommandFlags } = await import("./config.ts");
  const { extendConnectionAttemptTimeout, keepOutboundFetchOnHttp1 } =
    await import("../outboundHttp.ts");
  extendConnectionAttemptTimeout();
  keepOutboundFetchOnHttp1();
  const root = Command.make("goat", { ...sharedServerCommandFlags }).pipe(
    Command.withSubcommands([sshHelperCommand]),
  );
  Command.runWith(root, { version: packageJson.version })(args).pipe(
    Effect.scoped,
    Effect.provide([NodeServices.layer, NetService.layer]),
    NodeRuntime.runMain,
  );
}
