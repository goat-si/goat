import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CodexSettings,
  NodeId,
  type OrchestrationV2ProviderTurn,
  ProviderSessionId,
  type ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  ThreadId,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as CodexClient from "effect-codex-app-server/client";
import type * as CodexReplay from "effect-codex-app-server/replay";
import type * as Cause from "effect/Cause";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { codexReplayPreamble, makeCodexReplayHarness } from "./CodexAdapterV2.replay.testkit.ts";
import { CODEX_TEST_MODEL_SELECTION, CODEX_TEST_RUNTIME_POLICY } from "./CodexAdapterV2.testkit.ts";
import { makeCodexReplayTranscript } from "./CodexReplay.testkit.ts";

const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});

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
    sessionId: input.nativeThreadId,
    projectId: null,
    preview: "unused",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1782622440,
    updatedAt: 1782622440,
    status: { type: "idle" },
    path: `/tmp/${input.nativeThreadId}.jsonl`,
    cwd: "/workspace",
    cliVersion: "0.156.0",
    source: "vscode",
    threadSource: null,
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

it.effect.each([
  {
    name: "to thread start keeps imported history",
    nativeTurns: ["imported-turn", "first-goat-turn"],
    target: "thread_start" as const,
    turns: [{ id: "first-goat", ordinal: 1, nativeId: "first-goat-turn" }],
    expected: ["imported-turn"],
  },
  {
    name: "to a control turn reverts the later recorded turns",
    nativeTurns: ["kept", "later", "latest"],
    target: "goal-control",
    turns: [
      { id: "latest", ordinal: 4, nativeId: "latest" },
      { id: "kept", ordinal: 1, nativeId: "kept" },
      { id: "goal-control", ordinal: 2, nativeId: null },
      { id: "later", ordinal: 3, nativeId: "later" },
    ],
    expected: ["kept"],
  },
  {
    name: "to a control turn fails when no later turn has a native ID",
    nativeTurns: ["kept", "later", "latest"],
    target: "goal-control",
    turns: [
      { id: "latest", ordinal: 4, nativeId: null },
      { id: "kept", ordinal: 1, nativeId: "kept" },
      { id: "goal-control", ordinal: 2, nativeId: null },
      { id: "later", ordinal: 3, nativeId: null },
    ],
    expected: null,
  },
])("rewinding Codex twice $name", ({ nativeTurns: initialNativeTurns, target, turns, expected }) =>
  Effect.gen(function* () {
    const scenario = "codex-rewind-retry";
    const nativeThreadId = "rewind-retry-thread";
    const nativeTurns = [...initialNativeTurns];
    const input = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const preamble = makeCodexReplayTranscript({
      scenario,
      entries: codexReplayPreamble({
        nativeThreadId,
        nativeTurnId: initialNativeTurns.at(-1) ?? "unused",
        prompt: "unused",
      }),
    }).entries;
    const thread = codexReplayThreadResult({ nativeThreadId, forkedFromId: null });
    const client = yield* CodexClient.make(
      Stdio.make({
        args: Effect.succeed([]),
        stdin: Stream.fromQueue(input),
        stderr: () => Sink.drain,
        stdout: () =>
          Sink.forEach((chunk: string | Uint8Array) =>
            Effect.gen(function* () {
              const { id, method, params } = JSON.parse(
                typeof chunk === "string" ? chunk : decoder.decode(chunk),
              ) as { id?: number; method: string; params?: { beforeTurnId?: string } };
              if (id === undefined) return;
              const emit = (result: unknown) =>
                Queue.offer(input, encoder.encode(JSON.stringify({ id, result }) + "\n"));
              if (method === "config/read") {
                yield* emit({ config: {}, origins: {} });
                return;
              }
              if (method === "thread/turns/list") {
                yield* emit({
                  data: nativeTurns.toReversed().map((turnId) => ({
                    id: turnId,
                    items: [],
                    status: "completed",
                    error: null,
                  })),
                  nextCursor: null,
                });
                return;
              }
              if (method === "thread/revert") {
                const boundary = nativeTurns.indexOf(params?.beforeTurnId ?? "");
                assert.isAtLeast(boundary, 0);
                nativeTurns.splice(boundary);
              }
              if (method === "thread/read" || method === "thread/revert") {
                yield* emit({
                  thread: { ...thread.thread, projectId: null, historyMode: "paginated" },
                });
                return;
              }
              const response = preamble.find(
                (entry) => entry.type === "emit_inbound" && entry.label === method,
              );
              if (response?.type === "emit_inbound" && Predicate.isObject(response.frame)) {
                const result = response.frame.result;
                yield* emit(
                  method === "thread/start" &&
                    Predicate.isObject(result) &&
                    Predicate.isObject(result.thread)
                    ? { ...result, thread: { ...result.thread, projectId: null } }
                    : result,
                );
              } else {
                yield* Queue.offer(
                  input,
                  encoder.encode(
                    JSON.stringify({ id, error: { code: -32601, message: method } }) + "\n",
                  ),
                );
              }
            }),
          ),
      }),
    );
    const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
      instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_CODEX_SETTINGS,
      environment: {},
      clientFactory: { open: () => Effect.succeed(client) },
      digest: yield* Digest.Digest,
      fileSystem: yield* FileSystem.FileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* ProviderReplayHarness.makeReplayServerConfig(scenario).pipe(
        Effect.orDie,
      ),
    });
    const threadId = ThreadId.make(scenario);
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(scenario),
      modelSelection: CODEX_TEST_MODEL_SELECTION,
      runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: CODEX_TEST_MODEL_SELECTION,
      runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
    });
    const now = yield* DateTime.now;
    const providerThreadTurns = turns.map((turn) =>
      codexReplaySourceTurn({ ...turn, providerThreadId: providerThread.id, now }),
    );
    const targetTurn = providerThreadTurns.find((turn) => turn.id === target);
    const rollback = runtime
      .rollbackThread({
        providerThread,
        target:
          targetTurn === undefined
            ? {
                type: "thread_start",
                checkpointId: CheckpointId.make(scenario),
                appRunOrdinal: 0,
              }
            : {
                type: "provider_turn",
                checkpointId: CheckpointId.make(scenario),
                appRunOrdinal: targetTurn.ordinal,
                // The durable record owns the boundary when the target carries a stale ordinal.
                providerTurn: { ...targetTurn, ordinal: 4 },
              },
        providerThreadTurns,
      })
      .pipe(Effect.exit);
    assert.equal(Exit.isSuccess(yield* rollback), expected !== null);
    assert.deepEqual(nativeTurns, expected ?? initialNativeTurns);
    // A failed file restore retries with the original GOAT turn records.
    assert.equal(Exit.isSuccess(yield* rollback), expected !== null);
    assert.deepEqual(nativeTurns, expected ?? initialNativeTurns);
  }).pipe(Effect.scoped, Effect.provide(layerAdapterTest)),
);
