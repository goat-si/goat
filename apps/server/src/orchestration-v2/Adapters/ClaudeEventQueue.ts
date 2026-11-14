import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";

type Event = ProviderAdapter.ProviderAdapterV2Event;
type Slot = { event: Event };

function streamingKey(event: Event): { nodeId: string; kind: "node" | "item" } | null {
  if (
    event.type === "node.updated" &&
    event.node.kind === "assistant_message" &&
    event.node.status === "running"
  )
    return { nodeId: event.node.id, kind: "node" };
  if (
    event.type === "turn_item.updated" &&
    event.turnItem.type === "assistant_message" &&
    event.turnItem.streaming &&
    event.turnItem.nodeId !== null
  )
    return { nodeId: event.turnItem.nodeId, kind: "item" };
  return null;
}

export const makeClaudeEventQueue = Effect.fn("makeClaudeEventQueue")(function* () {
  const queue = yield* Queue.unbounded<Event>();
  const slots = new WeakMap<Event, Slot>();
  const lock = yield* Semaphore.make(1);
  // Other events and other nodes delimit the updates that may share queue slots.
  let activeNode: string | null = null;
  const pending = new Map<"node" | "item", Slot>();
  return {
    offer: (event: Event) =>
      Effect.uninterruptible(
        lock.withPermit(
          Effect.gen(function* () {
            const key = streamingKey(event);
            if (key === null || key.nodeId !== activeNode) {
              pending.clear();
              activeNode = key?.nodeId ?? null;
            }
            const existing = key === null ? undefined : pending.get(key.kind);
            if (existing !== undefined) {
              existing.event = event;
              return;
            }
            const slot = { event };
            if (key !== null) {
              pending.set(key.kind, slot);
              slots.set(event, slot);
            }
            yield* Queue.offer(queue, event);
          }),
        ),
      ),
    take: Effect.uninterruptibleMask((restore) =>
      restore(Queue.take(queue)).pipe(
        Effect.flatMap((queued) =>
          lock.withPermit(
            Effect.sync(() => {
              const slot = slots.get(queued);
              if (slot === undefined) return queued;
              slots.delete(queued);
              const key = streamingKey(slot.event);
              if (key !== null && pending.get(key.kind) === slot) pending.delete(key.kind);
              return slot.event;
            }),
          ),
        ),
      ),
    ),
  };
});
