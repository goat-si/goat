// Seam for v1 apps/web/src/hooks/useThreadRouteTarget.ts (goat 916b5ccc1b2): GOAT 2 does not use v1's router, so
// toasts never scope themselves to a v1 thread route. The type is v1's (threadRoutes.ts:8-20).
import type { ScopedThreadRef } from "@goat/contracts";

import type { DraftId } from "../composerDraftStore";

export type ThreadRouteTarget =
  | { kind: "server"; threadRef: ScopedThreadRef }
  | { kind: "draft"; draftId: DraftId };

export function useThreadRouteTarget(): ThreadRouteTarget | null {
  return null;
}
