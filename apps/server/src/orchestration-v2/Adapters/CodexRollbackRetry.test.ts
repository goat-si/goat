import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  NodeId,
  type OrchestrationV2ProviderTurn,
  type ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import type * as CodexReplay from "effect-codex-app-server/replay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { codexReplayPreamble, makeCodexReplayHarness } from "./CodexAdapterV2.replay.testkit.ts";
import { makeCodexReplayTranscript } from "./CodexReplay.testkit.ts";

const layerAdapterTest = Layer.mergeAll(
  IdAllocator.layer,
  MemoryDerivedCache.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
  NodeCrypto.layer,
);

const codexReplayThreadResult = (input: {
  readonly nativeThreadId: string;
  readonly forkedFromId: string | null;
}) => ({
  thread: {
    id: input.nativeThreadId,
    preview: "unused",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1782622440,
    updatedAt: 1782622440,
    status: { type: "idle" },
    path: `/tmp/${input.nativeThreadId}.jsonl`,
    cwd: "/workspace",
    cliVersion: "0.156.0",
    source: "appServer",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    forkedFromId: input.forkedFromId,
    turns: [],
  },
});

const codexReplaySourceTurn = (input: {
  readonly id: string;
  readonly ordinal: number;
  readonly nativeId: string | null;
  readonly providerThreadId: ProviderThreadId;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderTurn => ({
  id: ProviderTurnId.make(input.id),
  providerThreadId: input.providerThreadId,
  nodeId: NodeId.make(`node-${input.id}`),
  runAttemptId: RunAttemptId.make(`run-attempt-${input.id}`),
  nativeTurnRef:
    input.nativeId === null
      ? { driver: CodexAdapterV2.CODEX_DRIVER_KIND, nativeId: null, strength: "none" }
      : {
          driver: CodexAdapterV2.CODEX_DRIVER_KIND,
          nativeId: input.nativeId,
          strength: "strong",
        },
  ordinal: input.ordinal,
  status: "completed",
  startedAt: input.now,
  completedAt: input.now,
});

it.effect("does not revert the kept Codex turn when a rollback is retried", () =>
  Effect.gen(function* () {
    const nativeThreadId = "retried-rollback-thread";
    const exchange = (
      id: number,
      method: string,
      params: unknown,
      result: unknown,
    ): Array<CodexReplay.CodexAppServerReplayEntry> => [
      { type: "expect_outbound", label: method, frame: { id, method, params } },
      { type: "emit_inbound", label: method, frame: { id, result } },
    ];
    const transcript = makeCodexReplayTranscript({
      scenario: "codex-retried-rollback",
      entries: [
        ...codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: "retried-rollback-turn",
          prompt: "unused",
        }).slice(0, 5),
        ...exchange(
          3,
          "thread/read",
          { threadId: nativeThreadId, includeTurns: false },
          { thread: { id: nativeThreadId, historyMode: "paginated" } },
        ),
        ...exchange(
          4,
          "thread/turns/list",
          {
            threadId: nativeThreadId,
            cursor: null,
            limit: 100,
            sortDirection: "desc",
            itemsView: "summary",
          },
          {
            data: [{ id: "native-turn-1", items: [], status: "completed", error: null }],
            nextCursor: null,
          },
        ),
        ...exchange(
          5,
          "thread/read",
          { threadId: nativeThreadId, includeTurns: false },
          codexReplayThreadResult({ nativeThreadId, forkedFromId: null }),
        ),
      ],
    });
    const harness = yield* makeCodexReplayHarness(transcript);
    const now = yield* DateTime.now;
    const providerTurn = (ordinal: number) =>
      codexReplaySourceTurn({
        id: `provider-turn-${ordinal}`,
        ordinal,
        nativeId: `native-turn-${ordinal}`,
        providerThreadId: harness.providerThread.id,
        now,
      });
    const keptTurn = providerTurn(1);
    // A failed file restore retries after the first attempt already reverted every newer turn.
    // 100 newer turns hit the page-size cap, so a count-based revert sends this same request.
    const snapshot = yield* harness.runtime.rollbackThread({
      providerThread: harness.providerThread,
      target: {
        type: "provider_turn",
        checkpointId: CheckpointId.make("checkpoint-retried-rollback"),
        appRunOrdinal: 1,
        providerTurn: keptTurn,
      },
      providerThreadTurns: [
        keptTurn,
        ...Array.from({ length: 100 }, (_, index) => providerTurn(index + 2)),
      ],
    });

    assert.deepEqual(snapshot.providerThread.nativeConversationHeadRef, keptTurn.nativeTurnRef);
  }).pipe(Effect.scoped, Effect.provide(layerAdapterTest)),
);
