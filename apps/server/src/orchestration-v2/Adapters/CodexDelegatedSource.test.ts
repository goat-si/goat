import { CommandId, ThreadId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import {
  CODEX_TEST_MODEL_SELECTION,
  CODEX_TEST_RUNTIME_POLICY,
  withReplayRequestId,
} from "./CodexAdapterV2.testkit.ts";
import { codexReplayPreamble, makeCodexReplayHarness } from "./CodexAdapterV2.replay.testkit.ts";
import { makeCodexReplayTranscript } from "./CodexReplay.testkit.ts";

const layer = Layer.mergeAll(
  MemoryDerivedCache.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
  NodeCrypto.layer,
);

it.effect("marks allocator-issued delegated threads without marking ordinary threads", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const preamble = codexReplayPreamble({
        nativeThreadId: "parent",
        nativeTurnId: "unused",
        prompt: "unused",
      }).slice(0, 5);
      const child = codexReplayPreamble({
        nativeThreadId: "child",
        nativeTurnId: "unused",
        prompt: "unused",
      })
        .slice(3, 5)
        .map((entry) => withReplayRequestId(entry, 3))
        .map((entry) =>
          entry.type === "expect_outbound" &&
          Predicate.isObject(entry.frame) &&
          Predicate.isObject(entry.frame.params)
            ? {
                ...entry,
                frame: {
                  ...entry.frame,
                  params: {
                    ...entry.frame.params,
                    cwd: "/workspace",
                    model: "gpt-5.4",
                    threadSource: "subagent",
                  },
                },
              }
            : entry,
        );
      const sources: unknown[] = [];
      const harness = yield* makeCodexReplayHarness(
        makeCodexReplayTranscript({
          scenario: "delegated-source",
          entries: [...preamble, ...child],
        }),
        undefined,
        (method, params) =>
          Effect.sync(() => {
            if (method === "thread/start" && Predicate.isObject(params))
              sources.push(params.threadSource);
          }),
      );
      const threadId = (yield* IdAllocator.IdAllocatorV2).derive.delegatedTaskThread({
        commandId: CommandId.make("delegate:child"),
      });
      yield* harness.runtime.ensureThread({
        threadId,
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      assert.deepEqual(sources, [undefined, "subagent"]);
      assert.isFalse(IdAllocator.isDelegatedTaskThread(ThreadId.make("thread:ordinary")));
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect.each([-32602, -32600])(
  "retries an old launch when Codex rejects threadSource with %s",
  (errorCode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const preamble = codexReplayPreamble({
          nativeThreadId: "parent",
          nativeTurnId: "unused",
          prompt: "unused",
        }).slice(0, 5);
        const child = codexReplayPreamble({
          nativeThreadId: "child",
          nativeTurnId: "unused",
          prompt: "unused",
        })
          .slice(3, 5)
          .map((entry) => withReplayRequestId(entry, 3));
        const first = child[0];
        if (
          !first ||
          first.type !== "expect_outbound" ||
          !Predicate.isObject(first.frame) ||
          !Predicate.isObject(first.frame.params)
        )
          return yield* Effect.die("bad replay fixture");
        const retry = child
          .map((entry) => withReplayRequestId(entry, 4))
          .map((entry) =>
            entry.type === "expect_outbound" &&
            Predicate.isObject(entry.frame) &&
            Predicate.isObject(entry.frame.params)
              ? {
                  ...entry,
                  frame: {
                    ...entry.frame,
                    params: { ...entry.frame.params, cwd: "/workspace", model: "gpt-5.4" },
                  },
                }
              : entry,
          );
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario: "delegated-old-codex",
            entries: [
              ...preamble,
              {
                ...first,
                frame: {
                  ...first.frame,
                  params: {
                    ...first.frame.params,
                    cwd: "/workspace",
                    model: "gpt-5.4",
                    threadSource: "subagent",
                  },
                },
              },
              {
                type: "emit_inbound",
                frame: { id: 3, error: { code: errorCode, message: "unknown field threadSource" } },
              },
              ...retry,
            ],
          }),
        );
        const threadId = (yield* IdAllocator.IdAllocatorV2).derive.delegatedTaskThread({
          commandId: CommandId.make("delegate:old"),
        });
        const thread = yield* harness.runtime.ensureThread({
          threadId,
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        });
        assert.equal(thread.appThreadId, threadId);
      }),
    ).pipe(Effect.provide(layer)),
);
