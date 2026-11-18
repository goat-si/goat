import type { ProviderAdapterV2Event } from "@goat/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";

export const MAX_CURSOR_TASK_TEXT_CHARS = 256 * 1024;

// Each slot reserves a full segment, carried by up to two text events.
const MAX_PENDING_TASK_SNAPSHOTS = 16;

type TextSnapshot = readonly [ProviderAdapterV2Event, ...ProviderAdapterV2Event[]];

interface PendingSnapshot {
  readonly itemId: string;
  events: TextSnapshot;
}

export function makeTaskTextSnapshots(
  emit: (event: ProviderAdapterV2Event) => Effect.Effect<void>,
) {
  const live = new Map<string, PendingSnapshot>();
  const queued = new WeakMap<ProviderAdapterV2Event, PendingSnapshot>();
  let size = 0;
  return {
    offer: Effect.fnUntraced(function* (itemId: string, events: TextSnapshot) {
      const previous = live.get(itemId);
      if (previous !== undefined) {
        previous.events = events;
        return;
      }
      if (size >= MAX_PENDING_TASK_SNAPSHOTS) return;
      const pending = { itemId, events };
      live.set(itemId, pending);
      queued.set(events[0], pending);
      size++;
      // Keep the original queue position without retaining its superseded text.
      yield* emit(events[0]);
    }, Effect.uninterruptible),
    seal(itemId: string) {
      live.delete(itemId);
    },
    drain(event: ProviderAdapterV2Event): TextSnapshot {
      const pending = queued.get(event);
      if (pending === undefined) return [event];
      queued.delete(event);
      size--;
      if (live.get(pending.itemId) === pending) live.delete(pending.itemId);
      return pending.events;
    },
  };
}
