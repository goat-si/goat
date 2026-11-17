import { useAtomValue } from "@effect/atom-react";
import {
  createThreadLineageLookup,
  MAX_LINEAGE_LOOKUP_IDS,
  type LineageResolution,
} from "@goat/client-runtime/state/thread-lineage-lookup";
import { AuthOrchestrationReadScope, type EnvironmentId } from "@goat/contracts";
import { threadLinkIds } from "@goat/shared/threadLinks";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentThreadRefs } from "./entities";
import { useEnvironmentScope } from "./session";
import { environmentShell } from "./shell";

const lookup = createThreadLineageLookup(connectionAtomRuntime, environmentShell.stateValueAtom);
const EMPTY: LineageResolution = { checked: new Set(), titles: {}, projectIds: {} };
const EMPTY_ATOM = Atom.make(EMPTY);

/**
 * The titles and projects of the threads a message links that this client holds no shell for:
 * one paged read per message, shared by every link in it.
 */
export function useThreadLinkLookup(
  environmentId: EnvironmentId,
  markdown: string | null,
): LineageResolution {
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const held = useEnvironmentThreadRefs(markdown === null ? null : environmentId);
  const heldIds = new Set(held.map((ref) => ref.threadId));
  const ids =
    markdown === null
      ? []
      : threadLinkIds(markdown)
          .filter((threadId) => !heldIds.has(threadId))
          .toSorted()
          .slice(0, MAX_LINEAGE_LOOKUP_IDS);
  const anchor = ids[0];
  const atom =
    canRead && anchor !== undefined ? lookup.resolution(environmentId, anchor, ids) : EMPTY_ATOM;
  return useAtomValue(atom);
}
