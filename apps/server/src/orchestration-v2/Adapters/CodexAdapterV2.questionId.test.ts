import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import { RunAttemptId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import { codexReplayPreamble, makeCodexReplayHarness } from "./CodexAdapterV2.replay.testkit.ts";
import { makeCodexTestTurnInput } from "./CodexAdapterV2.testkit.ts";
import { makeCodexReplayTranscript, makeCodexReplayTurn } from "./CodexReplay.testkit.ts";

const layerAdapterTest = Layer.mergeAll(
  MemoryDerivedCache.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
  NodeCrypto.layer,
);

describe("CodexAdapterV2 user input questions", () => {
  it.effect("returns a Codex question's answer under its native question id", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "question-id-thread";
        const nativeTurnId = "question-id-turn";
        const transcript = makeCodexReplayTranscript({
          scenario: "codex-question-native-id",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Pick one." }),
            {
              type: "emit_inbound",
              label: "question",
              frame: {
                id: 100,
                method: "item/tool/requestUserInput",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  itemId: "question-id-item",
                  isBlocking: true,
                  questions: [
                    {
                      id: " choice ",
                      header: "Choice",
                      question: "Which option?",
                      options: [{ label: "A", description: "Option A" }],
                    },
                  ],
                },
              },
            },
            {
              type: "expect_outbound",
              label: "answer",
              frame: { id: 100, result: { answers: { " choice ": { answers: ["A"] } } } },
            },
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
            attemptId: RunAttemptId.make("question-id-attempt"),
            text: "Pick one.",
          }),
        );
        const questionItem = () =>
          harness.events.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "user_input_request"
              ? [event.turnItem]
              : [],
          )[0];
        const request = () =>
          harness.events.flatMap((event) =>
            event.type === "runtime_request.updated" ? [event.runtimeRequest] : [],
          )[0];
        yield* harness.awaitUntil(
          () => questionItem() !== undefined && request() !== undefined,
          "question published",
        );
        const publishedId = questionItem()!.questions[0]!.id;
        yield* harness.runtime.respondToRuntimeRequest({
          requestId: request()!.id,
          answers: { [publishedId]: ["A"] },
        });
        yield* harness.firstTerminal;
      }).pipe(Effect.provide(layerAdapterTest)),
    ),
  );
});
