import { useAtomValue } from "@effect/atom-react";
import type { SessionStreamUpdate } from "@goat/client-runtime/rpc";
import type { ChannelTaskChangesEvent, EnvironmentId } from "@goat/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";
import { channelEnvironment } from "~/state/channels";
import { useEnvironment } from "~/state/environments";

const NO_CHANGES = Atom.make(
  AsyncResult.initial<SessionStreamUpdate<ChannelTaskChangesEvent>, never>(false),
);

/**
 * Shares the server's signal per environment. Older servers, and a stream the server refused or
 * lost, read again when the person returns to the window instead, until a new session streams.
 */
export function useGoatBotTaskChanges(environmentId: EnvironmentId): string {
  const environment = useEnvironment(environmentId);
  const permitted = useAtomValue(channelEnvironment.taskChangesPermission(environmentId));
  const supported =
    permitted && environment?.serverConfig?.environment.capabilities.goatBotTaskChanges === true;
  const result = useAtomValue(
    supported ? channelEnvironment.taskChanges({ environmentId, input: {} }) : NO_CHANGES,
  );
  const update = Option.getOrNull(AsyncResult.value(result));
  const live = update !== null && "value" in update ? update : null;
  const streaming =
    supported && !AsyncResult.isFailure(result) && (update === null || live !== null);
  const [visits, setVisits] = useState(0);
  // oxlint-disable-next-line goat/react-effect-budget -- Without a task change stream, a return to the window is the signal.
  useEffect(() => {
    if (streaming) return;
    const onFocus = () => setVisits((n) => n + 1);
    const onVisibility = () => {
      if (document.visibilityState === "visible") onFocus();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [streaming]);
  // Each subscription's revision 0 says the server now tracks changes: one more read then catches
  // anything that landed before it, after a reconnect too, since the subscription is in the key.
  const position = live === null ? "pending" : `${live.subscription}:${live.value.revision}`;
  return streaming ? `stream:${position}` : `visit:${visits}`;
}
