import { ProviderDriverKind } from "@goat/contracts";
import type { IdAllocatorV2Derive } from "@goat/provider-core/server/IdAllocator";
import type { ProviderAdapterV2Event } from "@goat/provider-core/server/ProviderAdapter";
import type { V2McpServerStatusUpdatedNotification } from "effect-codex-app-server/schema";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { ActiveCodexTurnContext } from "./CodexAdapterV2.ts";

const driver = ProviderDriverKind.make("codex");

export function makeCodexMcpStartup(input: {
  readonly deriveId: IdAllocatorV2Derive["turnItemFromProviderItem"];
  readonly resolveItemPosition: (
    context: ActiveCodexTurnContext,
    id: string,
  ) => Effect.Effect<{ readonly ordinal: number; readonly startedAt: DateTime.Utc }>;
  readonly findActiveTurn: (id: string) => Effect.Effect<ActiveCodexTurnContext | undefined>;
  readonly emitProviderEvent: (event: ProviderAdapterV2Event) => Effect.Effect<void>;
}) {
  const pending = new Map<string, Map<string, string>>();
  const emit = Effect.fn("CodexAdapterV2.emitMcpStartupFailures")(function* (
    context: ActiveCodexTurnContext,
  ) {
    const threadId = context.providerThread.nativeThreadRef?.nativeId;
    if (threadId == null) return;
    const failures = pending.get(threadId);
    if (failures === undefined) return;
    pending.delete(threadId);
    for (const [name, message] of failures) {
      const nativeItemId = `mcp-startup-failed:${context.providerTurnId}:${name}`;
      const { ordinal, startedAt } = yield* input.resolveItemPosition(context, nativeItemId);
      yield* input.emitProviderEvent({
        type: "turn_item.updated",
        driver,
        turnItem: {
          id: input.deriveId({ driver, nativeItemId }),
          threadId: context.projectionThreadId,
          runId: context.projectionRunId,
          nodeId: context.providerNodeId,
          providerThreadId: context.providerThread.id,
          providerTurnId: context.providerTurnId,
          nativeItemRef: { driver, nativeId: nativeItemId, strength: "weak" },
          parentItemId: null,
          ordinal,
          type: "system_notice",
          status: "completed",
          title: `MCP server ${name} failed to start`,
          message,
          startedAt,
          completedAt: startedAt,
          updatedAt: startedAt,
        },
      });
    }
  });
  const handle = Effect.fn("CodexAdapterV2.handleMcpStartup")(function* (
    payload: V2McpServerStatusUpdatedNotification,
  ) {
    if (payload.threadId == null) return;
    const failures = pending.get(payload.threadId) ?? new Map<string, string>();
    if (payload.status !== "failed") {
      failures.delete(payload.name);
      if (failures.size === 0) pending.delete(payload.threadId);
      return;
    }
    if (!failures.has(payload.name) && failures.size >= 64) {
      const oldest = failures.keys().next().value;
      if (oldest !== undefined) failures.delete(oldest);
    }
    if (!pending.has(payload.threadId) && pending.size >= 128) {
      const oldest = pending.keys().next().value;
      if (oldest !== undefined) pending.delete(oldest);
    }
    failures.set(
      payload.name,
      payload.error?.trim() || `MCP server ${payload.name} failed to start.`,
    );
    pending.set(payload.threadId, failures);
    const context = yield* input.findActiveTurn(payload.threadId);
    if (context !== undefined) yield* emit(context);
  });
  return { emit, handle };
}
