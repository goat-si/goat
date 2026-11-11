import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@goat/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";
import { channelEnvironment } from "~/state/channels";
import { useEnvironment } from "~/state/environments";

const NO_CHANGES = Atom.make(AsyncResult.initial<{ readonly revision: number }, never>(false));

/**
 * Shares the server's signal per environment. Older servers, and a stream the server refused or
 * lost, read again when the person returns to the window instead.
 */
export function useGoatBotTaskChanges(environmentId: EnvironmentId): string {
  const environment = useEnvironment(environmentId);
  const supported = environment?.serverConfig?.environment.capabilities.goatBotTaskChanges === true;
  const result = useAtomValue(
    supported ? channelEnvironment.taskChanges({ environmentId, input: {} }) : NO_CHANGES,
  );
  const streaming = supported && !AsyncResult.isFailure(result);
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
  // The stream opens at revision 0, the state the first read already shows; only later ones change.
  const revision = Option.getOrNull(AsyncResult.value(result))?.revision ?? 0;
  return streaming ? `stream:${revision}` : `visit:${visits}`;
}
