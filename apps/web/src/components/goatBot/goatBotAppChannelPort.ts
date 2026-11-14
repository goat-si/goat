import { useAtomValue } from "@effect/atom-react";
import {
  type AtomCommand,
  createEnvironmentRpcCommand,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import { GoatBotUnreachable } from "@goat/client-runtime/goatBot";
import { CHANNEL_GATEWAY_WS_METHODS } from "@goat/contracts";

import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { channelEnvironment } from "~/state/channels";

import type { GoatBotChannelPort } from "./goatBotChannelPort";

// The badge reads on its own schedule, so it uses commands, not cached queries. Servers without
// getBotStatus are paged through listTasks.
const listTaskPage = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:channel:list-task-page",
  tag: CHANNEL_GATEWAY_WS_METHODS.listTasks,
});
const getBotStatus = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:channel:get-bot-status",
  tag: CHANNEL_GATEWAY_WS_METHODS.getBotStatus,
});

/** Settles a channel command, throwing the server's error (for example `legacy_active`). */
async function run<W, A, E>(command: AtomCommand<W, A, E>, value: W): Promise<A> {
  const result = await runAtomCommand(appAtomRegistry, command, value, { reportFailure: false });
  if (result._tag === "Failure") {
    // A dropped connection interrupts the request; keep Effect internals off the screen.
    if (isAtomCommandInterrupted(result)) throw new GoatBotUnreachable();
    throw squashAtomCommandFailure(result);
  }
  return result.value;
}

/** The app's one channel port, installed by GoatBotChannelProvider for the app's lifetime. */
export const goatBotAppChannelPort: GoatBotChannelPort = {
  ensureBot: (environmentId, input) => run(channelEnvironment.ensureBot, { environmentId, input }),
  getBotStatus: (environmentId) => run(getBotStatus, { environmentId, input: {} }),
  ingest: (environmentId, input) => run(channelEnvironment.ingest, { environmentId, input }),
  listTasks: (environmentId, input) => run(listTaskPage, { environmentId, input }),
  useCanSend: (environmentId) =>
    useAtomValue(channelEnvironment.ingest.permissionAtom(environmentId)),
};
