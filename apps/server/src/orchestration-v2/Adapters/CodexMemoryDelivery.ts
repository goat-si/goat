import { MemoryContextSnapshot, type RunId, type ThreadId } from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import type * as CodexSchema from "effect-codex-app-server/schema";

import type * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import type * as MemorySnapshot from "../../memory/MemorySnapshot.ts";

const encodeMemorySnapshot = Schema.encodeSync(Schema.fromJsonString(MemoryContextSnapshot));

interface DeliveredMemory {
  readonly snapshot: NonNullable<ProviderAdapter.ProviderAdapterV2TurnInput["memoryContext"]>;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly generation: number;
  unregister?: Effect.Effect<void>;
}

/**
 * The GOAT memory snapshot each native Codex thread was last given. Its body is held in the derived
 * cache, which can release it; the thread's additionalContext then keeps an empty memory entry.
 */
export const makeCodexMemoryDelivery = (deps: {
  readonly additionalContextByThread: Ref.Ref<
    Map<string, { readonly [key: string]: CodexSchema.V2TurnStartParams__AdditionalContextEntry }>
  >;
  readonly derivedCache: MemoryDerivedCache.MemoryDerivedCache["Service"];
  readonly memorySnapshots: MemorySnapshot.MemorySnapshot["Service"] | undefined;
  readonly scope: Scope.Scope;
}) => {
  const byThread = new Map<string, DeliveredMemory>();
  let generation = 0;
  const drop = Effect.fn("CodexMemoryDelivery.drop")(function* (nativeId: string) {
    byThread.delete(nativeId);
    yield* Ref.update(deps.additionalContextByThread, (current) => {
      const context = current.get(nativeId);
      if (!context?.goat_memory) return current;
      return new Map(current).set(nativeId, {
        ...context,
        goat_memory: { kind: "untrusted", value: "" },
      });
    });
  });
  const clear = Effect.fn("CodexMemoryDelivery.clear")(function* (
    nativeId: string,
    appThreadId?: ThreadId,
  ) {
    const selected = byThread.get(nativeId);
    if (selected?.unregister) yield* selected.unregister;
    yield* drop(nativeId);
    if (appThreadId && deps.memorySnapshots) yield* deps.memorySnapshots.invalidate(appThreadId);
  });
  const retain = Effect.fnUntraced(function* (
    nativeId: string,
    snapshot: MemoryContextSnapshot,
    turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
  ) {
    const selected: DeliveredMemory = {
      snapshot,
      threadId: turnInput.threadId,
      runId: turnInput.runId,
      generation: ++generation,
    };
    byThread.set(nativeId, selected);
    selected.unregister = yield* deps.derivedCache
      .retain({
        // Snapshot encoding plus its rendered additionalContext copy.
        bytes:
          new TextEncoder().encode(encodeMemorySnapshot(snapshot)).length +
          new TextEncoder().encode(snapshot.renderedText).length,
        release: Effect.gen(function* () {
          if (byThread.get(nativeId) === selected) yield* drop(nativeId);
        }),
      })
      .pipe(Effect.provideService(Scope.Scope, deps.scope));
  });
  return { byThread, generation: () => generation, clear, retain };
};
