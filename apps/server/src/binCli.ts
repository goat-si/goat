import {
  GOAT_CONNECT_CLI_COMING_SOON_MESSAGE,
  isGoatConnectEnabled,
} from "@goat/shared/goatConnect";
import * as Console from "effect/Console";
import * as Stdio from "effect/Stdio";
import { doctorCommand } from "./cli/doctor.ts";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Argument, Command } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import * as NetService from "@goat/shared/Net";
import packageJson from "../package.json" with { type: "json" };
import { acpMcpBridgeCommand, acpMcpCallCommand } from "./cli/acpMcpBridge.ts";
import { authCommand } from "./cli/auth.ts";
import { appCommand } from "./cli/app.ts";
import { browserCommand } from "./cli/browser.ts";
import { connectCommand } from "./cli/connect.ts";
import { pairCommand } from "./cli/pair.ts";
import { imessageCommand } from "./cli/imessage.ts";
import { hasCloudPublicConfig } from "./cloud/publicConfig.ts";
import { extendConnectionAttemptTimeout, keepOutboundFetchOnHttp1 } from "./outboundHttp.ts";
import { sharedServerCommandFlags } from "./cli/config.ts";
import { projectCommand } from "./cli/project.ts";
import { providerCommand } from "./cli/provider.ts";
import { threadCommand } from "./cli/thread.ts";
import { runDefaultServerCommand, serveCommand, startCommand } from "./cli/server.ts";
import { updateCommand } from "./cli/update.ts";
import { uninstallCommand } from "./cli/uninstall.ts";
import { serviceLauncherCommand } from "./cli/serviceLauncher.ts";
import { claudeHistoryCommand } from "./cli/claudeHistory.ts";
import { sshHelperCommand } from "./cli/sshHelper.ts";
import { serviceCommand } from "./cli/service.ts";
import { servicePreflightCommand } from "./cli/servicePreflight.ts";
import { themeCommand } from "./cli/theme.ts";
import { traceCommand } from "./cli/trace.ts";
import { triageCommand } from "./cli/triage.ts";

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NetService.layer);

const connectComingSoonCommand = Command.make("connect", {
  command: Argument.String("command").pipe(Argument.variadic),
}).pipe(
  Command.withDescription(GOAT_CONNECT_CLI_COMING_SOON_MESSAGE),
  Command.unlisted,
  Command.withHandler(() => Console.log(GOAT_CONNECT_CLI_COMING_SOON_MESSAGE)),
);

const connectPublicConfigMissingMessage =
  "T3 Connect commands are unavailable: this build is missing T3 Connect public configuration.";

class ConnectPublicConfigMissingError extends CliError.UserError {
  override get message() {
    return connectPublicConfigMissingMessage;
  }
}

// With the feature on, a build without its public configuration is a build
// problem the operator must see, so this exits non-zero unlike the coming-soon stub.
const connectMissingConfigCommand = Command.make("connect", {
  command: Argument.String("command").pipe(Argument.variadic),
}).pipe(
  Command.withDescription("T3 Connect is unavailable in builds without public configuration."),
  Command.unlisted,
  Command.withHandler(() =>
    Effect.fail(
      new CliError.ShowHelp({
        commandPath: ["goat", "connect"],
        errors: [new ConnectPublicConfigMissingError({ cause: connectPublicConfigMissingMessage })],
      }),
    ),
  ),
);

const selectConnectCommand = (cloudEnabled: boolean) =>
  !isGoatConnectEnabled()
    ? connectComingSoonCommand
    : cloudEnabled
      ? connectCommand
      : connectMissingConfigCommand;

export const makeCli = ({ cloudEnabled = hasCloudPublicConfig } = {}) =>
  Command.make("goat", { ...sharedServerCommandFlags }).pipe(
    Command.withDescription("Run the GOAT server."),
    Command.withHandler(runDefaultServerCommand),
    Command.withSubcommands([
      Command.make("help").pipe(
        Command.withDescription("Show command help."),
        Command.withHandler(() =>
          Effect.fail(new CliError.ShowHelp({ commandPath: ["goat"], errors: [] })),
        ),
      ),
      acpMcpBridgeCommand,
      acpMcpCallCommand,
      startCommand,
      serveCommand,
      appCommand,
      pairCommand,
      imessageCommand,
      authCommand,
      browserCommand,
      projectCommand,
      providerCommand,
      threadCommand,
      serviceCommand,
      updateCommand,
      uninstallCommand,
      serviceLauncherCommand,
      claudeHistoryCommand,
      sshHelperCommand,

      servicePreflightCommand,
      themeCommand,
      traceCommand,
      doctorCommand,
      triageCommand,
      selectConnectCommand(cloudEnabled),
    ]),
  );

export const cli = makeCli();

export const runCliWithArgs = (args: ReadonlyArray<string>, command = cli) =>
  Command.runWith(command, { version: packageJson.version })(
    !isGoatConnectEnabled() && args[0] === "connect" ? ["connect"] : args,
  );

export function runCli() {
  extendConnectionAttemptTimeout();
  keepOutboundFetchOnHttp1();
  Stdio.Stdio.use(({ args }) => Effect.flatMap(args, runCliWithArgs)).pipe(
    Effect.scoped,
    Effect.provide(layerCliRuntime),
    NodeRuntime.runMain,
  );
}
