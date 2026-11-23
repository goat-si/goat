import { RunAttemptId, type OrchestrationV2RuntimeRequest } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import { makeCodexTestTurnInput } from "./CodexAdapterV2.testkit.ts";
import { codexReplayPreamble, makeCodexReplayHarness } from "./CodexAdapterV2.replay.testkit.ts";
import { makeCodexReplayTranscript, makeCodexReplayTurn } from "./CodexReplay.testkit.ts";

it.effect.each([
  { name: "dangerous command", networkApprovalContext: undefined, asks: false },
  {
    name: "managed-network command",
    networkApprovalContext: { host: "example.com", protocol: "https" },
    asks: true,
  },
] as const)("full access asks about a $name: $asks", ({ networkApprovalContext, asks }) =>
  Effect.gen(function* () {
    const nativeThreadId = "command-approval-thread";
    const nativeTurnId = "command-approval-turn";
    const prompt = "Clean node_modules.";
    const pending = yield* Queue.unbounded<OrchestrationV2RuntimeRequest>();
    const harness = yield* makeCodexReplayHarness(
      makeCodexReplayTranscript({
        scenario: "full-access-command-approval",
        entries: [
          ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
          {
            type: "emit_inbound",
            frame: {
              id: 0,
              method: "item/commandExecution/requestApproval",
              params: {
                threadId: nativeThreadId,
                turnId: nativeTurnId,
                itemId: "exec-rm",
                command: "/bin/bash -lc 'rm -rf ./node_modules'",
                startedAtMs: 0,
                ...(networkApprovalContext === undefined ? {} : { networkApprovalContext }),
              },
            },
          },
          ...(asks
            ? []
            : ([
                { type: "expect_outbound", frame: { id: 0, result: { decision: "accept" } } },
                {
                  type: "emit_inbound",
                  frame: {
                    method: "turn/completed",
                    params: {
                      threadId: nativeThreadId,
                      turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                    },
                  },
                },
              ] as const)),
        ],
      }),
      (event) =>
        event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending"
          ? Queue.offer(pending, event.runtimeRequest)
          : Effect.void,
    );
    const turnInput = makeCodexTestTurnInput({
      threadId: harness.threadId,
      providerThread: harness.providerThread,
      now: yield* DateTime.now,
      attemptId: RunAttemptId.make("command-approval-attempt"),
      text: prompt,
    });
    yield* harness.runtime.startTurn({
      ...turnInput,
      runtimePolicy: { ...turnInput.runtimePolicy, runtimeMode: "full-access" },
    });
    const request = yield* Effect.raceFirst(
      harness.firstTerminal.pipe(Effect.as(undefined)),
      Queue.take(pending),
    );
    assert.equal(request?.kind, asks ? "command" : undefined);
    if (!asks) {
      assert.deepEqual(
        harness.terminalEvents().map((event) => event.status),
        ["completed"],
      );
    }
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        MemoryDerivedCache.layer,
        IdAllocator.layer,
        McpProviderSessions.layer,
        NodeServices.layer,
        NodeCrypto.layer,
      ),
    ),
  ),
);
