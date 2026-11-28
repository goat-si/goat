import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunAttemptId } from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import type * as CodexReplay from "effect-codex-app-server/replay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import { makeCodexTestTurnInput } from "./CodexAdapterV2.testkit.ts";
import { codexReplayPreamble, makeCodexReplayHarness } from "./CodexAdapterV2.replay.testkit.ts";
import { makeCodexReplayTranscript, makeCodexReplayTurn } from "./CodexReplay.testkit.ts";

const layerAdapterTest = Layer.mergeAll(
  MemoryDerivedCache.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
  NodeCrypto.layer,
);

// Upstream 836b86a5d6 extends a case in CodexAdapterV2.test.ts, which is at its entry; this file
// holds the phase check with a byte-for-byte copy of that file's finalAnswerTranscript helper.
describe("CodexAdapterV2 assistant message phases", () => {
  const finalAnswerTranscript = (
    scenario: string,
    answers: ReadonlyArray<{
      readonly id: string;
      readonly text: string;
      readonly phase?: "commentary" | "partial_answer" | "final_answer" | null;
      readonly omitPhase?: boolean;
      readonly streamed?: boolean;
      readonly completionDelayMs?: number;
    }>,
  ) => {
    const nativeThreadId = `native-${scenario}-thread`;
    const nativeTurnId = `native-${scenario}-turn`;
    const prompt = "Reply with the requested recovery marker.";
    return makeCodexReplayTranscript({
      scenario,
      entries: [
        ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
        ...answers.flatMap(
          (answer, index): ReadonlyArray<CodexReplay.CodexAppServerReplayEntry> => {
            const phase = answer.omitPhase
              ? {}
              : { phase: answer.phase === undefined ? ("final_answer" as const) : answer.phase };
            const completed: CodexReplay.CodexAppServerReplayEntry = {
              type: "emit_inbound",
              label: `item/completed/${answer.id}`,
              ...(answer.completionDelayMs === undefined
                ? {}
                : { afterMs: answer.completionDelayMs }),
              frame: {
                method: "item/completed",
                params: {
                  item: {
                    type: "agentMessage",
                    id: answer.id,
                    text: answer.text,
                    ...phase,
                    memoryCitation: null,
                  },
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  completedAtMs: 1782622441000 + index,
                },
              },
            };
            if (!answer.streamed) {
              return [completed];
            }
            return [
              {
                type: "emit_inbound",
                label: `item/started/${answer.id}`,
                frame: {
                  method: "item/started",
                  params: {
                    item: {
                      type: "agentMessage",
                      id: answer.id,
                      text: "",
                      ...phase,
                      memoryCitation: null,
                    },
                    threadId: nativeThreadId,
                    turnId: nativeTurnId,
                    startedAtMs: 1782622440500 + index,
                  },
                },
              },
              {
                type: "emit_inbound",
                label: `item/agentMessage/delta/${answer.id}`,
                frame: {
                  method: "item/agentMessage/delta",
                  params: {
                    threadId: nativeThreadId,
                    turnId: nativeTurnId,
                    itemId: answer.id,
                    delta: answer.text,
                  },
                },
              },
              completed,
            ];
          },
        ),
        {
          type: "emit_inbound",
          label: "turn/completed",
          frame: {
            method: "turn/completed",
            params: {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
            },
          },
        },
      ],
    });
  };

  it.effect.each([false, true])(
    "records Codex's phase on each assistant message (streamed: %s)",
    (streamed) =>
      Effect.scoped(
        Effect.gen(function* () {
          const transcript = finalAnswerTranscript("codex-message-phases", [
            { id: "status", text: "Checking the files", phase: "commentary", streamed },
            { id: "partial", text: "CODEX_RECOVERY_OK", phase: "partial_answer", streamed },
            { id: "final", text: "CODEX_RECOVERY_OK", phase: "final_answer", streamed },
            { id: "unphased", text: "No phase", omitPhase: true, streamed },
          ]);
          const harness = yield* makeCodexReplayHarness(transcript);
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-codex-message-phases"),
              text: "Reply with the requested recovery marker.",
            }),
          );
          yield* harness.firstTerminal;
          const completed = harness.events.flatMap((event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "assistant_message" &&
            !event.turnItem.streaming
              ? [event.turnItem]
              : [],
          );
          const phaseOf = (nativeId: string) =>
            completed.findLast((item) => item.nativeItemRef?.nativeId === nativeId)?.phase;
          assert.equal(phaseOf("status"), "commentary");
          assert.equal(phaseOf("partial"), "partial_answer");
          assert.equal(phaseOf("final"), "final_answer");
          assert.isUndefined(phaseOf("unphased"));
          assert.isTrue(completed.some((item) => item.nativeItemRef?.nativeId === "unphased"));
        }).pipe(Effect.provide(layerAdapterTest)),
      ),
  );

  it.effect.each([false, true])(
    "emits a message whose phase this build does not know without a phase (streamed: %s)",
    (streamed) =>
      Effect.scoped(
        Effect.gen(function* () {
          const transcript = finalAnswerTranscript("codex-unknown-phase", [
            // Codex types the phase as a string; a newer one must not reach the stored item.
            { id: "summary", text: "What changed", phase: "summary" as never, streamed },
            { id: "final", text: "CODEX_RECOVERY_OK", phase: "final_answer", streamed },
          ]);
          const harness = yield* makeCodexReplayHarness(transcript);
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-codex-unknown-phase"),
              text: "Reply with the requested recovery marker.",
            }),
          );
          yield* harness.firstTerminal;
          const summary = harness.events.flatMap((event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "assistant_message" &&
            event.turnItem.nativeItemRef?.nativeId === "summary"
              ? [event.turnItem]
              : [],
          );
          assert.isTrue(summary.some((item) => !item.streaming && item.text === "What changed"));
          assert.isTrue(summary.every((item) => item.phase === undefined));
        }).pipe(Effect.provide(layerAdapterTest)),
      ),
  );

  it.effect("keeps an asynchronous Codex alert distinguishable from the final answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "async-alert-thread";
        const nativeTurnId = "async-alert-turn";
        const agentMessage = (id: string, text: string, delivery: "async" | null) => ({
          type: "emit_inbound" as const,
          label: id,
          frame: {
            method: "item/completed",
            params: {
              threadId: nativeThreadId,
              turnId: nativeTurnId,
              item: {
                type: "agentMessage",
                id,
                text,
                phase: "final_answer",
                delivery,
                questions: null,
              },
            },
          },
        });
        const transcript = makeCodexReplayTranscript({
          scenario: "async-alert-and-final-answer",
          entries: [
            ...codexReplayPreamble({
              nativeThreadId,
              nativeTurnId,
              prompt: "Alert me, then finish.",
            }),
            agentMessage("call_alert_1", "I found an important detail.", "async"),
            agentMessage("msg_final", "Here is the ordinary final answer.", null),
            {
              type: "emit_inbound",
              label: "complete",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("async-alert-attempt"),
            text: "Alert me, then finish.",
          }),
        );
        yield* harness.firstTerminal;
        const classification = (nativeId: string) => {
          const item = harness.events.findLast(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "assistant_message" &&
              event.turnItem.nativeItemRef?.nativeId === nativeId,
          );
          assert.equal(item?.type, "turn_item.updated");
          if (item?.type !== "turn_item.updated") return {};
          const {
            id: _id,
            nodeId: _nodeId,
            messageId: _messageId,
            nativeItemRef: _nativeItemRef,
            ordinal: _ordinal,
            text: _text,
            startedAt: _startedAt,
            completedAt: _completedAt,
            updatedAt: _updatedAt,
            ...rest
          } = item.turnItem as typeof item.turnItem & { messageId?: unknown; text?: unknown };
          return rest;
        };
        assert.notDeepEqual(classification("call_alert_1"), classification("msg_final"));
      }).pipe(Effect.provide(layerAdapterTest)),
    ),
  );
});
