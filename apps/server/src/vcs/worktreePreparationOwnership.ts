import type * as Effect from "effect/Effect";

export interface WorktreePreparationOwnership {
  readonly path: string;
  readonly release: Effect.Effect<void>;
}
