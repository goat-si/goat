import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunAttemptId } from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";

import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import { makeCodexTestTurnInput } from "./CodexAdapterV2.testkit.ts";
import {
  childAgentMessage,
  childTurnCompleted,
  makeCodexReplayHarness,
  RESUME_CHILD_TURN_1,
  RESUME_PROMPT,
  RESUME_SCENARIO,
  resumeSubagentTranscript,
} from "./CodexAdapterV2.replay.testkit.ts";
import { makeCodexReplayTranscript } from "./CodexReplay.testkit.ts";

const layerAdapterTest = Layer.mergeAll(
  MemoryDerivedCache.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
);

describe("CodexAdapterV2 native subagent wakes", () => {
  it.effect("wakes the parent when a native child finishes after the parent's turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entries = resumeSubagentTranscript.entries;
        const labelIndex = (label: string) =>
          entries.findIndex((entry) => entry.type === "emit_inbound" && entry.label === label);
        const rootCompleted = labelIndex("turn/completed/root");
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario: RESUME_SCENARIO,
            entries: [
              ...entries.slice(0, labelIndex(`turn/started/${RESUME_CHILD_TURN_1}`) + 1),
              ...entries.slice(rootCompleted - 1, rootCompleted + 1),
              childAgentMessage({
                id: "child-late-answer",
                text: "NATIVE_CHILD_16900_DONE",
                turnId: RESUME_CHILD_TURN_1,
                completedAtMs: 1782622480000,
                afterMs: 60_000,
              }),
              childTurnCompleted(RESUME_CHILD_TURN_1),
            ],
          }),
        );

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-codex-late-child"),
            text: RESUME_PROMPT,
          }),
        );
        yield* harness.awaitUntil(() => harness.terminalEvents().length >= 1, "turn 1 terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        assert.lengthOf(harness.continuationRequests, 0);

        yield* TestClock.adjust("60 seconds");
        yield* harness.awaitUntil(
          () => harness.subagentUpdates().at(-1)?.subagent.result === "NATIVE_CHILD_16900_DONE",
          "replay condition",
        );
        assert.equal(harness.subagentUpdates().at(-1)?.subagent.status, "completed");
        assert.lengthOf(harness.continuationRequests, 1);
        assert.include(harness.continuationRequests[0]?.detail, "NATIVE_CHILD_16900_DONE");
        assert.equal(harness.continuationRequests[0]?.delivery, "message_text");
        assert.equal(
          harness.continuationRequests[0]?.notification?.aboutRunId,
          "run-attempt-codex-late-child",
        );
      }).pipe(Effect.provide(layerAdapterTest)),
    ),
  );
});
