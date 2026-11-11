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
      /** The last refresh failed; these asks are from an earlier read and may be out of date. */
      readonly staleRetry: (() => void) | null;
    };

/**
 * Open asks close when answered, not when a chat is visited. Read again whenever the roster comes
 * into view with the app in front (no channel.subscribeTaskChanges on the client runtime yet). A
 * failed refresh keeps earlier asks marked out of date, or shows only the failure after an empty read.
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
  const earlier = asks.data;
  const failed = asks.error !== null;
  if (failed && (earlier === null || (earlier.asks.length === 0 && earlier.total === 0)))
    return { state: "failed", retry: refresh };
  if (earlier !== null)
    return {
      state: "ready",
      asks: earlier.asks,
      total: earlier.total,
      truncated: earlier.truncated,
      staleRetry: failed ? refresh : null,
    };
  return { state: "loading" };
}
