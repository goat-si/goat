import { useAtomValue } from "@effect/atom-react";
import {
  createThreadLineageLookup,
  MAX_LINEAGE_LOOKUP_IDS,
  type LineageResolution,
} from "@goat/client-runtime/state/thread-lineage-lookup";
import { AuthOrchestrationReadScope, type EnvironmentId, type ThreadId } from "@goat/contracts";
import type { ThreadRelationshipWalkRow } from "@goat/client-runtime/state/thread-relationships";
import { Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentShell } from "./shell";
import { useEnvironmentScope } from "./session";

const lineageLookup = createThreadLineageLookup(
  connectionAtomRuntime,
  environmentShell.stateValueAtom,
);
const EMPTY: LineageResolution = { checked: new Set(), titles: {} };
const EMPTY_ATOM = Atom.make(EMPTY);

export function useThreadLineageResolution(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly rows: ReadonlyArray<ThreadRelationshipWalkRow>;
  readonly liveIds: ReadonlySet<ThreadId>;
}): LineageResolution {
  const canRead = useEnvironmentScope(input.environmentId, AuthOrchestrationReadScope);
  const ids: ThreadId[] = [];
  for (const { threadId, edge } of input.rows) {
    if (edge.kind === "subagent" || input.liveIds.has(threadId)) continue;
    ids.push(threadId);
    if (ids.length === MAX_LINEAGE_LOOKUP_IDS) break;
  }
  const atom =
    canRead && ids.length > 0
      ? lineageLookup.resolution(input.environmentId, input.threadId, ids)
      : EMPTY_ATOM;
  return useAtomValue(atom);
}

export function lineageRowExists(
  row: ThreadRelationshipWalkRow,
  result: LineageResolution,
): boolean {
  return (
    row.edge.kind === "subagent" ||
    !result.checked.has(row.threadId) ||
    Object.hasOwn(result.titles, row.threadId)
  );
}
