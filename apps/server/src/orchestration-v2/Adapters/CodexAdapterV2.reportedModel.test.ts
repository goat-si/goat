import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { RunAttemptId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import { makeCodexTestTurnInput } from "./CodexAdapterV2.testkit.ts";
import { codexReplayPreamble, makeCodexReplayHarness } from "./CodexAdapterV2.replay.testkit.ts";
import { makeCodexReplayTranscript, makeCodexReplayTurn } from "./CodexReplay.testkit.ts";

const layerAdapterTest = Layer.mergeAll(
  MemoryDerivedCache.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
);

describe("CodexAdapterV2 reported model", () => {
  it.effect("records the model Codex reports on the root provider turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "reported-model-thread";
        const nativeTurnId = "reported-model-turn";
        const transcript = makeCodexReplayTranscript({
          scenario: "codex-reported-model",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "say hi" }),
            {
              type: "emit_inbound",
              label: "rerouted",
              frame: {
                method: "model/rerouted",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  fromModel: "gpt-6-astra",
                  toModel: "gpt-5.6-sol",
                  reason: "highRiskCyberActivity",
                },
              },
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
            attemptId: RunAttemptId.make("reported-model-attempt"),
            text: "say hi",
          }),
        );
        yield* harness.firstTerminal;
        const completed = harness.events.find(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
        );
        assert.equal(completed?.type, "provider_turn.updated");
        if (completed?.type !== "provider_turn.updated") return;
        assert.deepEqual(completed.providerTurn.turnTokenUsage?.models, ["gpt-5.6-sol"]);
        assert.equal(completed.providerTurn.model, "gpt-5.6-sol");
      }).pipe(Effect.provide(layerAdapterTest)),
    ),
  );
});
