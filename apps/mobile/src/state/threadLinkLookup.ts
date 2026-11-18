import { useAtomValue } from "@effect/atom-react";
import {
  createThreadLineageLookup,
  MAX_LINEAGE_LOOKUP_IDS,
  THREAD_LINK_LOOKUP_CACHE,
  type LineageResolution,
} from "@goat/client-runtime/state/thread-lineage-lookup";
import { AuthOrchestrationReadScope, type EnvironmentId } from "@goat/contracts";
import { threadLinkIds } from "@goat/shared/threadLinks";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentScope } from "./session";
import { environmentShell } from "./shell";
import { environmentThreadShells } from "./threads";

const lookup = createThreadLineageLookup(
  connectionAtomRuntime,
  environmentShell.stateValueAtom,
  THREAD_LINK_LOOKUP_CACHE,
);
const EMPTY: LineageResolution = { checked: new Set(), titles: {}, projectIds: {} };
const EMPTY_ATOM = Atom.make(EMPTY).pipe(Atom.withLabel("mobile-thread-link-lookup:empty"));
const NO_REFS_ATOM = Atom.make<ReadonlyArray<{ readonly threadId: string }>>([]);

/**
 * The titles and projects of the threads a message links that this client holds no shell for:
 * one paged read per message, shared by its labels and its chip icons.
 */
export function useThreadLinkLookup(
  environmentId: EnvironmentId,
  markdown: string,
): LineageResolution {
  const linked = threadLinkIds(markdown);
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const held = useAtomValue(
    linked.length === 0
      ? NO_REFS_ATOM
      : environmentThreadShells.environmentThreadRefsAtom(environmentId),
  );
  const heldIds = new Set(held.map((ref) => ref.threadId));
  const ids = linked
    .filter((threadId) => !heldIds.has(threadId))
    .sort()
    .slice(0, MAX_LINEAGE_LOOKUP_IDS);
  const anchor = ids[0];
  return useAtomValue(
    canRead && anchor !== undefined ? lookup.resolution(environmentId, anchor, ids) : EMPTY_ATOM,
  );
}
