import type { OrchestrationV2TurnItem, ProviderDriverKind } from "@goat/contracts";
import type * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { ActiveTurn, ThreadState } from "./adapterState.ts";
import { isOwnPrompt } from "./promptIds.ts";

export type ItemBase = Omit<
  Extract<OrchestrationV2TurnItem, { type: "user_message" }>,
  "type" | "createdBy" | "creationSource" | "messageId" | "inputIntent" | "text" | "attachments"
>;

export const makeExternalPrompts = (deps: {
  readonly driver: ProviderDriverKind;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly emit: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<void>;
  readonly itemBase: (
    state: ThreadState,
    turn: ActiveTurn,
    nativeId: string,
    status: OrchestrationV2TurnItem["status"],
    startedAt: DateTime.Utc,
    completedAt: DateTime.Utc | null,
    updatedAt: DateTime.Utc,
  ) => ItemBase;
}) => {
  const { driver, idAllocator, emit } = deps;

  // GOAT's own prompts are sent while their turn is active, so only other clients reach here.
  const emitPrompt = Effect.fnUntraced(function* (
    state: ThreadState,
    turn: ActiveTurn,
    inboxId: string,
    text: string,
  ) {
    const now = yield* DateTime.now;
    const base = {
      ...deps.itemBase(state, turn, inboxId, "completed", now, now, now),
      nodeId: turn.input.rootNodeId,
    };
    // History derives the same ID from the message ID, so a later snapshot does not duplicate it.
    const messageId = idAllocator.derive.messageFromProviderItem({
      driver,
      nativeItemId: inboxId,
    });
    yield* emit({
      type: "message.updated",
      driver,
      message: {
        createdBy: "user",
        creationSource: "provider",
        id: messageId,
        threadId: turn.input.threadId,
        runId: turn.input.runId,
        nodeId: base.nodeId,
        role: "user",
        text,
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    });
    yield* emit({
      type: "turn_item.updated",
      driver,
      turnItem: {
        ...base,
        createdBy: "user",
        creationSource: "provider",
        type: "user_message",
        messageId,
        inputIntent: "turn_start",
        text,
        attachments: [],
      },
    });
  });

  return {
    emitPrompt,
    /** Records a user prompt queued while no GOAT turn ran; false when the event is not one. */
    onEnqueued: (state: ThreadState, inboxId: string, text: string, held: boolean) => {
      if (state.subagent !== undefined) state.subagent.prompt ??= text;
      // GOAT's own prompts can be admitted after a failed submit ended their turn.
      else if (!isOwnPrompt(inboxId)) {
        state.externalPrompts.set(inboxId, { text, leads: !held && state.reports.size === 0 });
      }
    },
    // History begins at whichever OpenCode queued first: a report or another client's prompt.
    // A prompt leads only this wake, so one dropped undelivered cannot move a later boundary.
    takeLeading: (state: ThreadState) => {
      const leading = [...state.externalPrompts].find(([, prompt]) => prompt.leads)?.[0];
      for (const prompt of state.externalPrompts.values()) prompt.leads = false;
      return leading;
    },
  };
};
