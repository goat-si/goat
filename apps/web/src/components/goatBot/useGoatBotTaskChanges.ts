import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@goat/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";
import { channelEnvironment } from "~/state/channels";
import { useEnvironment } from "~/state/environments";

const NO_CHANGES = Atom.make(AsyncResult.initial<{ readonly revision: number }, never>(false));

/** Shares the server's signal per environment; older servers refresh when the user returns. */
export function useGoatBotTaskChanges(environmentId: EnvironmentId): string {
  const environment = useEnvironment(environmentId);
  const supported = environment?.serverConfig?.environment.capabilities.goatBotTaskChanges === true;
  const result = useAtomValue(
    supported ? channelEnvironment.taskChanges({ environmentId, input: {} }) : NO_CHANGES,
  );
  const [visits, setVisits] = useState(0);
  // oxlint-disable-next-line goat/react-effect-budget -- Older servers have no task change stream.
  useEffect(() => {
    if (supported) return;
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
  }, [supported]);
  const revision = Option.getOrNull(AsyncResult.value(result))?.revision;
  return supported ? `stream:${revision ?? "pending"}` : `visit:${visits}`;
}
