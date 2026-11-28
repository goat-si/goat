// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite seeds the Antigravity native step database fixture.
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import type * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";

import { makeAntigravityAcpRuntime } from "../../provider/acp/AntigravityAcpSupport.ts";
import { normalizeAntigravitySessionUpdate } from "../../provider/acp/AntigravityProtocol.ts";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import { makeAntigravityAdapterV2 } from "./AntigravityAdapterV2.ts";

const layerSession = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

describe("AntigravityAdapterV2 silent finished reply", () => {
  it.effect("completes a turn whose finished reply went silent instead of failing on timeout", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const profileDirectory = yield* fs.makeTempDirectoryScoped({
        prefix: "goat-antigravity-silent-reply-",
      });
      const conversations = path.join(profileDirectory, "antigravity-acp", "conversations");
      yield* fs.makeDirectory(conversations, { recursive: true });
      const appendStep = (type: number, status: number, payload: string) => {
        const database = new NodeSqlite.DatabaseSync(path.join(conversations, "mock-session-1.db"));
        try {
          database.exec(
            "CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB)",
          );
          database
            .prepare("INSERT INTO steps (step_type, status, step_payload) VALUES (?, ?, ?)")
            .run(type, status, Buffer.from(payload));
        } finally {
          database.close();
        }
      };
      // USER_INPUT before the prompt, so the outcome check reads only this turn's steps.
      appendStep(14, 3, "Summarize the README.");
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      const replied = yield* Deferred.make<void>();
      const instanceId = ProviderInstanceId.make("antigravity-silent-reply-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        profileDirectory,
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { GOAT_ACP_ANTIGRAVITY: "1", GOAT_ACP_HANG_PROMPT_FOREVER: "1" },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  sessionUpdate = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
              // The reply streams and the session log records it DONE; session/prompt never answers.
              prompt: (request, promptOptions) =>
                Effect.gen(function* () {
                  const fiber = yield* runtime
                    .prompt(request, promptOptions)
                    .pipe(Effect.forkChild);
                  if (promptOptions?.dispatched !== undefined) {
                    yield* Deferred.await(promptOptions.dispatched);
                  }
                  if (sessionUpdate !== undefined) {
                    yield* sessionUpdate(
                      normalizeAntigravitySessionUpdate({
                        sessionId: "mock-session-1",
                        update: {
                          sessionUpdate: "agent_message_chunk",
                          content: { type: "text", text: "The README describes GOAT." },
                        },
                      }),
                    );
                  }
                  appendStep(15, 3, "The README describes GOAT.");
                  yield* Deferred.succeed(replied, undefined);
                  return yield* Fiber.join(fiber);
                }),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const threadId = ThreadId.make("thread-antigravity-silent-reply");
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-silent-reply"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const terminal = yield* session.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
        Effect.forkScoped,
      );
      const now = yield* DateTime.now;
      yield* session
        .startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            modelSelection,
            runtimePolicy,
            now,
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(replied);
      // Exactly the deadline: a longer jump would also fire the outcome check's own timeout.
      yield* TestClock.adjust("15 minutes");
      const ended = Option.getOrUndefined(yield* Fiber.join(terminal));
      assert.equal(
        ended?.type === "turn.terminal" && ended.status,
        "completed",
        ended?.type === "turn.terminal" ? ended.failure?.message : undefined,
      );
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});
