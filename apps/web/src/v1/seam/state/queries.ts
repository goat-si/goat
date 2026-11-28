// Seam (lane F): replaces v1 apps/web/src/state/queries.ts @916b5cc. v1 queries.ts holds the environment query atoms. Lifted code imports only this type, copied verbatim.
// Listed in docs/PROVENANCE.md (v1 bridge table).
import type { OrchestrationV2GetTurnItemResult, ThreadId, TurnItemId } from "@goat/contracts";
import type { AsyncResult, Atom } from "effect/reactivity";

/** Reads one item's detail from somewhere other than the environment, as the guest page does. */
export type TurnItemDetailSource = (input: {
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly revision: string;
}) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationV2GetTurnItemResult, unknown>>;
