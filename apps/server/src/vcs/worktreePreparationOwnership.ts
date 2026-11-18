import type * as Effect from "effect/Effect";

export interface WorktreePreparationOwnership {
  readonly path: string;
  readonly rollback: (branch: string | null) => Effect.Effect<boolean>;
  readonly release: Effect.Effect<void>;
}
