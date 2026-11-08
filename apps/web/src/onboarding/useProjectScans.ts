import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { DEFAULT_AGENT_SESSION_WINDOW_DAYS, type EnvironmentId } from "@goat/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext } from "react";

import { agentSessionScan } from "../state/agentSessions";
import { environmentIdsKey } from "../state/environmentAtomList";
import { formatEnvironmentQueryError } from "../state/query";

const scanAtom = (environmentId: EnvironmentId, windowDays: number) =>
  agentSessionScan({ environmentId, input: { includePi: true, windowDays } });

const KEY_SEPARATOR = "\u0000";
const projectScansAtom = Atom.family((key: string) => {
  const separator = key.indexOf(KEY_SEPARATOR);
  const idsKey = separator === -1 ? key : key.slice(0, separator);
  const windowDays =
    separator === -1 ? DEFAULT_AGENT_SESSION_WINDOW_DAYS : Number(key.slice(separator + 1));
  return Atom.make((get) =>
    idsKey === ""
      ? []
      : (idsKey.split("\n") as EnvironmentId[]).map((environmentId) =>
          get(scanAtom(environmentId, windowDays)),
        ),
  ).pipe(Atom.withLabel(`web-project-scans:${idsKey}:${windowDays}`));
});

export function useProjectScans(
  environmentIds: readonly EnvironmentId[],
  windowDays = DEFAULT_AGENT_SESSION_WINDOW_DAYS,
) {
  const registry = useContext(RegistryContext);
  const results = useAtomValue(
    projectScansAtom(`${environmentIdsKey(environmentIds)}${KEY_SEPARATOR}${windowDays}`),
  );
  return environmentIds.map((environmentId, index) => {
    const result = results[index]!;
    return {
      environmentId,
      data: Option.getOrNull(AsyncResult.value(result)),
      error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
      isPending: result.waiting || result._tag === "Initial",
      refresh: () => registry.refresh(scanAtom(environmentId, windowDays)),
    };
  });
}
