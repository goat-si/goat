import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type * as ProjectionStore from "./ProjectionStore.ts";

export const agentModeSelectionUpdate = Effect.fn("ProviderEventIngestor.agentModeSelectionUpdate")(
  function* (
    projections: ProjectionStore.ProjectionStoreV2["Service"],
    event: Extract<
      ProviderAdapter.ProviderAdapterV2Event,
      { type: "thread_model_selection.updated" }
    >,
  ) {
    const thread = yield* projections
      .getThread(event.threadId)
      .pipe(Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }));
    const current = thread?.modelSelection;
    if (thread === null || current?.instanceId !== event.instanceId || !current.options)
      return null;
    let changed = false;
    const options = current.options.map((option) => {
      const change = event.changes.find(
        (candidate) => candidate.id === option.id && candidate.from === option.value,
      );
      if (change === undefined) return option;
      changed = true;
      return { ...option, value: change.to };
    });
    if (!changed) return null;
    const now = yield* DateTime.now;
    return {
      type: "thread.model-selection-updated" as const,
      threadId: thread.id,
      payload: { ...thread, modelSelection: { ...current, options }, updatedAt: now },
      occurredAt: now,
    };
  },
);
