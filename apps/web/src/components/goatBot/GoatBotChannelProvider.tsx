import { useAtomValue } from "@effect/atom-react";
import {
  type AtomCommand,
  createEnvironmentRpcCommand,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CHANNEL_GATEWAY_WS_METHODS } from "@t3tools/contracts";
import type { PropsWithChildren } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { channelEnvironment } from "~/state/channels";

import { GoatBotChannelContext, type GoatBotChannelPort } from "./goatBotChannelPort";

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
    if (isAtomCommandInterrupted(result)) throw new Error("Couldn't reach GOAT Bot.");
    throw squashAtomCommandFailure(result);
  }
  return result.value;
}

const port: GoatBotChannelPort = {
  ensureBot: (environmentId, input) => run(channelEnvironment.ensureBot, { environmentId, input }),
  getBotStatus: (environmentId) => run(getBotStatus, { environmentId, input: {} }),
  ingest: (environmentId, input) => run(channelEnvironment.ingest, { environmentId, input }),
  listTasks: (environmentId, input) => run(listTaskPage, { environmentId, input }),
  useCanSend: (environmentId) =>
    useAtomValue(channelEnvironment.ingest.permissionAtom(environmentId)),
};

/** Gives GOAT Bot its server connection. Mounted once for the app's lifetime, never swapped. */
export function GoatBotChannelProvider({ children }: PropsWithChildren) {
  return <GoatBotChannelContext.Provider value={port}>{children}</GoatBotChannelContext.Provider>;
}
