import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, RunAttemptId, type RunId, ThreadId } from "@goat/contracts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";

import * as MemorySnapshot from "../../memory/MemorySnapshot.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import {
  layerAdapterTest,
  unusedRegistry,
  wp4Memory,
} from "./CodexAdapterV2.attachment.testkit.ts";
import { codexReplayPreamble, makeCodexReplayHarness } from "./CodexAdapterV2.replay.testkit.ts";
import {
  CODEX_TEST_MODEL_SELECTION,
  CODEX_TEST_RUNTIME_POLICY,
  makeCodexTestTurnInput,
  withReplayRequestId,
} from "./CodexAdapterV2.testkit.ts";
import { makeCodexReplayTranscript, makeCodexReplayTurn } from "./CodexReplay.testkit.ts";

describe("Codex additional context restoration", () => {
  it.effect.each([
    "survives",
    "revoked",
    "restore timeout",
    "injection failure",
    "manual compaction",
  ] as const)(
    "settles revalidated context restoration before starting the next turn (%s)",
    (outcome) =>
      Effect.scoped(
        Effect.gen(function* () {
          const nativeThreadId = `wp4-restore-${outcome}`;
          const nativeTurnId = "restore-turn";
          const manual = outcome === "manual compaction";
          const initialTurnId = manual ? "initial-memory-turn" : nativeTurnId;
          const scenario = `wp4-restore-${outcome}`;
          const threadId = ThreadId.make(`thread-${scenario}`);
          const snapshot = wp4Memory();
          const keepsMemory = outcome === "survives" || manual;
          const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
            nativeThreadId,
            codexInput: [{ type: "text", text: "work" }],
            runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
            modelSelection: CODEX_TEST_MODEL_SELECTION,
            hasGoatMcp: true,
            memoryContext: snapshot,
          });
          const context = { ...params.additionalContext };
          if (!keepsMemory) delete context.goat_memory;
          const original = codexReplayPreamble({
            nativeThreadId,
            nativeTurnId: initialTurnId,
            prompt: "work",
          });
          const nextTurnId = "following-turn";
          const otherNativeId = "other-native-thread";
          const otherTurn = codexReplayPreamble({
            nativeThreadId: otherNativeId,
            nativeTurnId: "other-turn",
            prompt: "unrelated",
          });
          const parallel = outcome === "survives";
          const injectId = parallel ? 6 : manual ? 5 : 4;
          const nextId = outcome === "restore timeout" ? injectId : injectId + 1;
          const nextParams = yield* CodexAdapterV2.buildCodexTurnStartParams({
            nativeThreadId,
            codexInput: [{ type: "text", text: "continue" }],
            runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
            modelSelection: CODEX_TEST_MODEL_SELECTION,
            hasGoatMcp: true,
            clearMemoryContext: true,
            ...(keepsMemory ? { memoryContext: snapshot } : {}),
          });
          const items = Object.entries(context).map(([key, entry]) => ({
            type: "message",
            role: entry.kind === "untrusted" ? "user" : "developer",
            content: [
              {
                type: "input_text",
                text:
                  entry.kind === "untrusted"
                    ? `<external_${key}>${entry.value}</external_${key}>`
                    : `<${key}>${entry.value}</${key}>`,
              },
            ],
          }));
          assert.isTrue(
            items.some((item) => !item.content[0]?.text.includes("external_goat_memory")),
          );
          const transcript = makeCodexReplayTranscript({
            scenario,
            entries: [
              ...original.slice(0, 5),
              { type: "expect_outbound", frame: { id: 3, method: "turn/start", params } },
              ...original.slice(6),
              ...(manual
                ? ([
                    {
                      type: "emit_inbound",
                      frame: {
                        method: "turn/completed",
                        params: {
                          threadId: nativeThreadId,
                          turn: makeCodexReplayTurn({ id: initialTurnId, status: "completed" }),
                        },
                      },
                    },
                    {
                      type: "expect_outbound",
                      frame: {
                        id: 4,
                        method: "thread/compact/start",
                        params: { threadId: nativeThreadId },
                      },
                    },
                    { type: "emit_inbound", frame: { id: 4, result: {} } },
                    {
                      type: "emit_inbound",
                      frame: {
                        method: "turn/started",
                        params: {
                          threadId: nativeThreadId,
                          turn: makeCodexReplayTurn({ id: nativeTurnId, status: "inProgress" }),
                        },
                      },
                    },
                  ] as const)
                : []),
              {
                type: "emit_inbound",
                frame: {
                  method: "item/completed",
                  params: {
                    threadId: nativeThreadId,
                    turnId: nativeTurnId,
                    item: { type: "contextCompaction", id: "restore-item" },
                  },
                },
              },
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
              ...(parallel
                ? [
                    ...otherTurn.slice(3, 5).map((entry) => withReplayRequestId(entry, 4)),
                    ...otherTurn.slice(5, 7).map((entry) => withReplayRequestId(entry, 5)),
                    ...otherTurn.slice(7),
                  ]
                : []),
              ...(outcome === "restore timeout"
                ? []
                : ([
                    {
                      type: "expect_outbound",
                      frame: {
                        id: injectId,
                        method: "thread/inject_items",
                        params: { threadId: nativeThreadId, items },
                      },
                    },
                    {
                      type: "emit_inbound",
                      label: "restored context",
                      frame:
                        outcome === "injection failure"
                          ? { id: injectId, error: { code: -32603, message: "injection failed" } }
                          : { id: injectId, result: {} },
                    },
                  ] as const)),
              ...(outcome === "restore timeout" || outcome === "injection failure"
                ? ([
                    {
                      type: "expect_outbound",
                      frame: {
                        id: nextId,
                        method: "thread/inject_items",
                        params: { threadId: nativeThreadId, items },
                      },
                    },
                    {
                      type: "emit_inbound",
                      frame: { id: nextId, error: { code: -32603, message: "retry failed" } },
                    },
                  ] as const)
                : ([
                    {
                      type: "expect_outbound",
                      frame: manual
                        ? {
                            id: nextId,
                            method: "thread/compact/start",
                            params: { threadId: nativeThreadId },
                          }
                        : { id: nextId, method: "turn/start", params: nextParams },
                    },
                    {
                      type: "emit_inbound",
                      frame: {
                        id: nextId,
                        result: manual
                          ? {}
                          : { turn: makeCodexReplayTurn({ id: nextTurnId, status: "inProgress" }) },
                      },
                    },
                  ] as const)),
            ],
          });
          yield* (yield* McpProviderSessions.McpProviderSessions).set({
            environmentId: EnvironmentId.make("fixture"),
            threadId,
            providerSessionId: "wp4-restore-credential",
            providerInstanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
            endpoint: "http://127.0.0.1:43123/mcp",
            authorizationHeader: "Bearer fixture",
            browserToolsAvailable: true,
            grantedScopes: ["memory:read", "orchestration:read"],
          });
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let execution: { threadId: ThreadId; runId: RunId } | undefined;
          let revalidations = 0;
          const injected = yield* Deferred.make<void>();
          const injectionReply = yield* Deferred.make<void>();
          const refreshed = yield* Deferred.make<void>();
          const harness = yield* makeCodexReplayHarness(
            transcript,
            undefined,
            (method) =>
              method === "thread/inject_items"
                ? Deferred.succeed(injected, undefined)
                : Effect.void,
            undefined,
            (entry) =>
              entry.label === "restored context" ? Deferred.await(injectionReply) : Effect.void,
          ).pipe(
            Effect.provideService(MemorySnapshot.MemorySnapshot, {
              forThread: () => Effect.die("restoration must not reselect"),
              invalidate: () => Effect.void,
              revalidate: (originalSnapshot, currentExecution, policy) =>
                Effect.gen(function* () {
                  assert.strictEqual(originalSnapshot, snapshot);
                  execution = currentExecution;
                  revalidations++;
                  assert.deepEqual(yield* policy, { grant: "read", policyEpoch: 1 });
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                  return keepsMemory ? originalSnapshot : undefined;
                }),
            }),
            Effect.provideService(McpSessionRegistry.McpSessionRegistry, {
              ...unusedRegistry,
              currentMemoryPolicy: () => Effect.succeed({ grant: "read", policyEpoch: 1 }),
            }),
          );
          const input = makeCodexTestTurnInput({
            threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("wp4-restore"),
            text: "work",
          });
          yield* harness.runtime.startTurn({
            ...input,
            refreshMemoryContext: () => Effect.succeed(snapshot),
          });
          const compactInput = makeCodexTestTurnInput({
            threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("wp4-first-manual-compaction"),
            text: "/compact",
          });
          if (manual) {
            yield* harness.firstTerminal;
            yield* harness.runtime.compactThread!({
              ...compactInput,
              refreshMemoryContext: () => Effect.succeed(snapshot),
            });
          }
          yield* Deferred.await(entered);
          assert.deepEqual(execution, {
            threadId: input.threadId,
            runId: manual ? compactInput.runId : input.runId,
          });
          // The session can report completion while the restore RPC is still pending.
          yield* harness.awaitUntil(
            () => harness.terminalEvents().length === (manual ? 2 : 1),
            "compacting turn completed",
          );
          const followingInput = makeCodexTestTurnInput({
            threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("wp4-next-after-restore"),
            text: "continue",
          });
          const start = manual ? harness.runtime.compactThread! : harness.runtime.startTurn;
          if (outcome === "revoked" || manual) {
            const cancelledRefreshed = yield* Deferred.make<void>();
            const cancelled = yield* start({
              ...followingInput,
              refreshMemoryContext: () =>
                Deferred.succeed(cancelledRefreshed, undefined).pipe(Effect.as(snapshot)),
            }).pipe(Effect.forkChild({ startImmediately: true }));
            assert.isFalse(
              yield* Deferred.isDone(cancelledRefreshed),
              "cancelled attempt refreshed before restoration",
            );
            yield* Fiber.interrupt(cancelled);
            assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(cancelled)));
          }
          const following = yield* start({
            ...followingInput,
            refreshMemoryContext: () =>
              Deferred.succeed(refreshed, undefined).pipe(
                Effect.as(keepsMemory ? snapshot : undefined),
              ),
          }).pipe(Effect.forkChild({ startImmediately: true }));
          assert.isFalse(yield* Deferred.isDone(refreshed), "refreshed before revalidation");
          if (parallel) {
            const otherThreadId = ThreadId.make("unrelated-goat-thread");
            const otherProviderThread = yield* harness.runtime.ensureThread({
              threadId: otherThreadId,
              modelSelection: CODEX_TEST_MODEL_SELECTION,
              runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
            });
            yield* harness.runtime.startTurn(
              makeCodexTestTurnInput({
                threadId: otherThreadId,
                providerThread: otherProviderThread,
                now: yield* DateTime.now,
                attemptId: RunAttemptId.make("unrelated-start-during-restore"),
                text: "unrelated",
              }),
            );
          }
          if (outcome === "restore timeout") {
            yield* TestClock.adjust("10 seconds");
          } else {
            yield* Deferred.succeed(release, undefined);
            yield* Effect.raceFirst(
              Deferred.await(injected),
              Fiber.join(following).pipe(
                Effect.andThen(Effect.die("started before requesting context injection")),
              ),
            );
            assert.isFalse(yield* Deferred.isDone(refreshed), "refreshed before injection reply");
            yield* Deferred.succeed(injectionReply, undefined);
          }
          const result = yield* Effect.exit(Fiber.join(following));
          if (outcome === "restore timeout" || outcome === "injection failure") {
            assert.isTrue(Exit.isFailure(result), "start must fail when context restoration fails");
            if (Exit.isFailure(result)) {
              assert.include(Cause.pretty(result.cause), "ProviderAdapterTurnStartError");
              assert.include(
                Cause.pretty(result.cause),
                "Codex could not restore context after compaction",
              );
            }
            assert.isFalse(yield* Deferred.isDone(refreshed));
            return;
          }
          assert.isTrue(Exit.isSuccess(result));
          assert.isTrue(yield* Deferred.isDone(refreshed));
          assert.equal(revalidations, 1);
          assert.isTrue(yield* Deferred.isDone(injected));
          const memoryItem = items.find((item) =>
            item.content[0]?.text.includes("external_goat_memory"),
          );
          if (keepsMemory) {
            assert.equal(memoryItem?.role, "user");
            assert.include(memoryItem!.content[0]!.text, "&lt;untrusted&gt;");
          } else assert.isUndefined(memoryItem);
        }).pipe(Effect.provide(layerAdapterTest)),
      ),
  );

  // Codex 0.171 keeps additionalContext in the compacted history, so a restore sends it twice.
  it.effect("does not restore GOAT context that Codex kept through compaction", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "kept-context-thread";
        const nativeTurnId = "kept-context-turn";
        const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
          nativeThreadId,
          codexInput: [{ type: "text", text: "work" }],
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          hasGoatMcp: true,
        });
        const entries = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "work" }).map(
          (entry) =>
            entry.type === "emit_inbound" && entry.label === "initialize"
              ? {
                  ...entry,
                  frame: {
                    id: 1,
                    result: {
                      userAgent: "GOAT/0.171.0",
                      codexHome: "/tmp/codex-home",
                      platformFamily: "unix",
                      platformOs: "macos",
                    },
                  },
                }
              : entry,
        );
        const transcript = makeCodexReplayTranscript({
          scenario: "kept-context",
          entries: [
            ...entries.slice(0, 5),
            {
              type: "expect_outbound",
              label: "context turn",
              frame: { id: 3, method: "turn/start", params },
            },
            ...entries.slice(6),
            {
              type: "emit_inbound",
              label: "compacted",
              frame: {
                method: "item/completed",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  item: { type: "contextCompaction", id: "compact-kept" },
                },
              },
            },
            {
              type: "emit_inbound",
              label: "done",
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
        const requested: Array<string> = [];
        yield* (yield* McpProviderSessions.McpProviderSessions).set({
          environmentId: EnvironmentId.make("test"),
          threadId: ThreadId.make("thread-kept-context"),
          providerSessionId: "kept-context-session",
          providerInstanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
          endpoint: "http://127.0.0.1:43123/mcp",
          authorizationHeader: "Bearer test",
          browserToolsAvailable: true,
        });
        const harness = yield* makeCodexReplayHarness(transcript, undefined, (method) =>
          Effect.sync(() => requested.push(method)),
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("kept-context-attempt"),
            text: "work",
          }),
        );
        yield* harness.firstTerminal;
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        assert.notInclude(
          requested,
          "thread/inject_items",
          "injected GOAT context that Codex kept in its compacted history",
        );
      }).pipe(Effect.provide(layerAdapterTest)),
    ),
  );
});
