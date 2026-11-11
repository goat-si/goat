import { createEnvironmentRpcQueryAtomFamily } from "@goat/client-runtime/state/runtime";
import {
  CHANNEL_GATEWAY_WS_METHODS,
  type ChannelOpenAsk,
  type EnvironmentId,
} from "@goat/contracts";
import { useEffect } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useAppActive } from "../../lib/appState";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";

// What each bot waits on the person for, across the owner's bots, in one read.
const openAsks = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:channel:list-open-asks",
  tag: CHANNEL_GATEWAY_WS_METHODS.listOpenAsks,
  staleTimeMs: 2_000,
});

export type MobileOpenAsks =
  /** A server before open asks: the roster keeps its per-bot badges and shows no strip. */
  | { readonly state: "unsupported" }
  | { readonly state: "loading" }
  | { readonly state: "failed"; readonly retry: () => void }
  | {
      readonly state: "ready";
      readonly asks: ReadonlyArray<ChannelOpenAsk>;
      readonly total: number;
      /** The server read part of the waiting work; `total` is a lower bound. */
      readonly truncated: boolean;
    };

/**
 * Everything that waits on the person on the bots' machine. Open asks close when they are answered,
 * not when a chat is visited. Read again whenever the roster comes into view with the app in front;
 * the client runtime cannot subscribe to channel.subscribeTaskChanges yet. A failed read wins over
 * the last good one, so it never looks like nothing waits.
 */
export function useMobileOpenAsks(
  environmentId: EnvironmentId | null,
  visible: boolean,
): MobileOpenAsks {
  const { presentationById } = useEnvironments();
  const presentation = environmentId === null ? undefined : presentationById.get(environmentId);
  const supported =
    environmentId !== null &&
    presentation?.connection.phase === "connected" &&
    presentation.serverConfig?.environment.capabilities.goatBotOpenAsks === true;
  const asks = useEnvironmentQuery(supported ? openAsks({ environmentId, input: {} }) : null);
  const inView = useAppActive() && visible;
  const refresh = asks.refresh;
  // oxlint-disable-next-line goat/react-effect-budget -- Read the open asks again each time the roster comes into view with the app in front.
  useEffect(() => {
    if (supported && inView) refresh();
  }, [supported, inView, refresh]);
  if (!supported) return { state: "unsupported" };
  if (asks.error !== null) return { state: "failed", retry: refresh };
  if (asks.data !== null)
    return {
      state: "ready",
      asks: asks.data.asks,
      total: asks.data.total,
      truncated: asks.data.truncated,
    };
  return { state: "loading" };
}
