import type { OrchestrationV2TurnItem, ProviderDriverKind } from "@goat/contracts";
import type * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { HTML_RENDER_TOOL_NAME } from "@goat/shared/htmlRender";
import { htmlRenderFromToolItem } from "@goat/shared/toolOutput";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { recordValue } from "../records.ts";
import { openCodeCodeModeHtmlRenders } from "../toolItems.ts";
import type { ActiveTurn, ThreadState } from "./adapterState.ts";
import type { ItemBase } from "./externalPrompts.ts";

export const makeNestedHtmlRenderEmitter = (deps: {
  readonly driver: ProviderDriverKind;
  readonly mcpSessions: McpProviderSessions.McpProviderSessions["Service"];
  readonly mcpServerNameFor: (threadId: string) => Effect.Effect<string>;
  readonly emit: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<void>;
  readonly emitNode: (
    state: ThreadState,
    turn: ActiveTurn,
    nativeId: string,
    kind: "tool_call",
    status: "completed",
    startedAt: DateTime.Utc,
    completedAt: DateTime.Utc,
  ) => Effect.Effect<void>;
  readonly itemBase: (
    state: ThreadState,
    turn: ActiveTurn,
    nativeId: string,
    status: "completed",
    startedAt: DateTime.Utc,
    completedAt: DateTime.Utc,
    updatedAt: DateTime.Utc,
  ) => ItemBase;
}) =>
  Effect.fnUntraced(function* (
    state: ThreadState,
    turn: ActiveTurn,
    nativeId: string,
    parent: OrchestrationV2TurnItem,
    metadata: unknown,
    startedAt: DateTime.Utc,
    updatedAt: DateTime.Utc,
  ) {
    if (parent.type !== "dynamic_tool" || parent.toolName !== "execute") return;
    const calls = recordValue(metadata, "toolCalls");
    if (!Array.isArray(calls) || calls.length === 0) return;
    const returned = htmlRenderFromToolItem(parent);
    const pages = openCodeCodeModeHtmlRenders(
      calls,
      yield* deps.mcpServerNameFor(turn.input.threadId),
    );
    for (const { index, input } of pages) {
      const id = `${nativeId}:${HTML_RENDER_TOOL_NAME}:${index}`;
      if (turn.takenPages.has(id) || turn.takenPages.size >= 1024) continue;
      turn.takenPages.add(id);
      const page = yield* deps.mcpSessions.takeHtmlRender(turn.input.threadId, input);
      if (page === undefined || page.attachmentId === returned?.attachmentId) continue;
      yield* deps.emitNode(state, turn, id, "tool_call", "completed", startedAt, updatedAt);
      yield* deps.emit({
        type: "turn_item.updated",
        driver: deps.driver,
        turnItem: {
          ...deps.itemBase(state, turn, id, "completed", startedAt, updatedAt, updatedAt),
          type: "dynamic_tool",
          toolName: `goat.${HTML_RENDER_TOOL_NAME}`,
          input: { title: page.title, height: page.height },
          output: { htmlRender: page },
        },
      });
    }
  });
