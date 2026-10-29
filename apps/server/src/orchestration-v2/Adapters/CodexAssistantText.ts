import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import {
  makeProviderTextDeltaCoalescer,
  type ProviderTextDeltaUpdate,
} from "./ProviderTextDeltaCoalescer.ts";

export const makeCodexAssistantText = Effect.fn("CodexAssistantText.make")(function* (input: {
  readonly flushIntervalMs: number;
  readonly emit: (
    update: ProviderTextDeltaUpdate & { readonly sealed?: boolean },
  ) => Effect.Effect<void>;
}) {
  const pending = new Map<
    string,
    {
      turnId: string;
      itemId: string;
      text: string;
      completed: boolean;
      root: boolean;
      published: string;
      lineFlushed: boolean;
      sealed: boolean;
    }
  >();
  const key = (turnId: string, itemId: string) => JSON.stringify([turnId, itemId]);
  const publication = yield* Semaphore.make(1);
  // This callback runs per coalesced chunk under the provider's existing span.
  const emit = Effect.fnUntraced(function* (update: ProviderTextDeltaUpdate, sealed = false) {
    const item = pending.get(key(update.turnId, update.itemId));
    if (!update.completed && item !== undefined && update.text !== item.text) return;
    if (!update.completed && item?.published === update.text && (!sealed || item.sealed)) return;
    if (item !== undefined) {
      item.published = update.text;
      item.sealed ||= sealed;
    }
    yield* input.emit({ ...update, ...(sealed ? { sealed: true } : {}) });
    if (update.completed) pending.delete(key(update.turnId, update.itemId));
  }, publication.withPermit);
  const coalescer = yield* makeProviderTextDeltaCoalescer({ ...input, emit });
  return {
    ...coalescer,
    // Token deltas retain the adapter's span instead of creating one per token.
    append: Effect.fnUntraced(function* (update: {
      turnId: string;
      itemId: string;
      delta: string;
      root: boolean;
    }) {
      const id = key(update.turnId, update.itemId);
      const item = pending.get(id) ?? {
        ...update,
        text: "",
        published: "",
        completed: false,
        lineFlushed: false,
        sealed: false,
      };
      item.text += update.delta;
      pending.set(id, item);
      yield* coalescer.append(update);
      if (item.root && !item.lineFlushed && item.text.includes("\n")) {
        item.lineFlushed = true;
        yield* emit(item, true);
      }
    }),
    flushBeforeTool: Effect.fn("CodexAssistantText.flushBeforeTool")(function* (turnId: string) {
      for (const item of pending.values()) {
        if (item.turnId === turnId && item.root && item.text.length > 0) yield* emit(item, true);
      }
    }),
  };
});
