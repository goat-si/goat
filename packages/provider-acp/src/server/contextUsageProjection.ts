import type {
  ModelSelection,
  OrchestrationV2ProviderThread,
  ProviderDriverKind,
  ThreadTokenUsageSnapshot,
} from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Ref from "effect/Ref";
import type * as EffectAcpSchema from "effect-acp/compat";

import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import type { ActiveAcpTurn } from "./activeTurn.ts";
import type { AcpAdapterV2Flavor } from "./adapterFlavor.ts";

export function makeAcpContextUsageProjection(deps: {
  readonly driver: ProviderDriverKind;
  readonly flavor: Pick<AcpAdapterV2Flavor, "extractContextUsage" | "getModelContextWindow">;
  readonly activeSessionId: Ref.Ref<string | null>;
  readonly activeSelection: Ref.Ref<ModelSelection | null>;
  readonly activeSessionSetup: Ref.Ref<AcpSessionRuntime.AcpSessionRuntimeStartResult | null>;
  readonly activeTurn: Ref.Ref<ActiveAcpTurn | null>;
  readonly providerThreadByNativeSessionId: Ref.Ref<
    ReadonlyMap<string, OrchestrationV2ProviderThread>
  >;
  readonly contextUsageBySessionId: Ref.Ref<ReadonlyMap<string, ThreadTokenUsageSnapshot>>;
  readonly nativeMetadataBySessionId: Ref.Ref<
    ReadonlyMap<string, Readonly<Record<string, unknown>>>
  >;
  readonly emitProviderEvent: (
    event: ProviderAdapter.ProviderAdapterV2Event,
  ) => Effect.Effect<void>;
}) {
  const withModelContextWindow = Effect.fnUntraced(function* (
    sessionId: string,
    usage: ThreadTokenUsageSnapshot,
  ) {
    if (sessionId !== (yield* Ref.get(deps.activeSessionId))) return usage;
    const selection = yield* Ref.get(deps.activeSelection);
    const setup = yield* Ref.get(deps.activeSessionSetup);
    if (selection === null || setup === null) return usage;
    const maxTokens = deps.flavor.getModelContextWindow?.(selection, setup);
    return maxTokens === undefined ? usage : { ...usage, maxTokens };
  });

  const publishProviderThreadState = Effect.fnUntraced(function* (
    sessionId: string,
    context: ActiveAcpTurn | null,
  ) {
    const knownProviderThread = (yield* Ref.get(deps.providerThreadByNativeSessionId)).get(
      sessionId,
    );
    if (knownProviderThread === undefined) return;
    const now = yield* DateTime.now;
    const providerThread: OrchestrationV2ProviderThread = {
      ...knownProviderThread,
      // The settled turn's snapshot is still cached as active; no turn runs now.
      ...(context === null && knownProviderThread.status === "active"
        ? { status: "idle" as const }
        : {}),
      contextUsage:
        (yield* Ref.get(deps.contextUsageBySessionId)).get(sessionId) ??
        knownProviderThread.contextUsage ??
        null,
      nativeMetadata:
        (yield* Ref.get(deps.nativeMetadataBySessionId)).get(sessionId) ??
        knownProviderThread.nativeMetadata ??
        null,
      updatedAt: now,
    };
    yield* Ref.update(deps.providerThreadByNativeSessionId, (current) =>
      new Map(current).set(sessionId, providerThread),
    );
    yield* deps.emitProviderEvent({
      type: "provider_thread.updated",
      driver: deps.driver,
      providerThread,
      // Agents like Kimi report usage after the prompt settles, when no run receives it.
      ...(context === null ? { sessionScoped: true } : {}),
    });
  });

  // Replayed history only records the snapshot; `ensureThread` publishes it.
  const projectExtractedContextUsage = Effect.fnUntraced(function* (
    notification: EffectAcpSchema.SessionNotification,
    live: boolean,
  ) {
    if (notification.update.sessionUpdate === "usage_update") return;
    const reportedUsage = deps.flavor.extractContextUsage?.(notification);
    if (reportedUsage === undefined) return;
    const previous = (yield* Ref.get(deps.contextUsageBySessionId)).get(notification.sessionId);
    const usage = yield* withModelContextWindow(notification.sessionId, {
      ...previous,
      ...reportedUsage,
    });
    if (previous !== undefined && Equal.equals(previous, usage)) return;
    yield* Ref.update(deps.contextUsageBySessionId, (current) =>
      new Map(current).set(notification.sessionId, usage),
    );
    const context = yield* Ref.get(deps.activeTurn);
    if (context?.nativeThreadId === notification.sessionId) context.contextUsage = usage;
    if (live) yield* publishProviderThreadState(notification.sessionId, context);
  });

  const resolveReplayedContextUsage = Effect.fnUntraced(function* (sessionId: string) {
    const replayedUsage = (yield* Ref.get(deps.contextUsageBySessionId)).get(sessionId);
    const contextUsage =
      replayedUsage === undefined ? null : yield* withModelContextWindow(sessionId, replayedUsage);
    if (contextUsage !== null) {
      yield* Ref.update(deps.contextUsageBySessionId, (current) =>
        new Map(current).set(sessionId, contextUsage),
      );
    }
    return contextUsage;
  });

  return {
    publishProviderThreadState,
    projectExtractedContextUsage,
    resolveReplayedContextUsage,
  };
}
