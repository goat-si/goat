import { assert, describe, it } from "@effect/vitest";
import { MessageId, ProviderInstanceId, ProviderSessionId, RunId, ThreadId } from "@goat/contracts";
import { AcpProviderCapabilitiesV2, makeAcpAdapterV2 } from "@goat/provider-acp/server/adapter";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { ACP_TEST_DRIVER, layerTest } from "./AcpAdapterV2.host.testkit.ts";
import {
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
  makeTurnInput,
} from "./AcpAdapterV2.testkit.ts";

describe("AcpAdapterV2 concurrent replay requests", () => {
  it.live("pairs responses to concurrent same-method requests in request order", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-acp-fifo-" });
      const statusPath = path.join(directory, "status.json");
      const instanceId = ProviderInstanceId.make("acp-test-concurrent-prompts");
      const threadId = ThreadId.make("thread-acp-concurrent-prompts");
      const sessionId = "concurrent-session";
      const update = (sessionUpdate: Record<string, unknown>) => ({
        type: "emit_inbound",
        frame: {
          kind: "notification",
          method: "session/update",
          params: { sessionId, update: sessionUpdate },
        },
      });
      // A prompt steer is a second session/prompt while the first still runs, so two
      // same-method client requests are open at once when the first response arrives.
      const transcript = yield* decodeAcpReplayTranscript(
        {
          provider: ACP_TEST_DRIVER,
          protocol: "acp.ndjson-jsonrpc",
          version: "1",
          scenario: "concurrent-prompts",
          entries: [
            {
              type: "expect_outbound",
              frame: { kind: "request", method: "initialize", params: "<any>" },
            },
            {
              type: "emit_inbound",
              frame: {
                kind: "response",
                method: "initialize",
                result: {
                  protocolVersion: 1,
                  agentCapabilities: { sessionCapabilities: { close: {} } },
                  authMethods: [],
                },
              },
            },
            {
              type: "expect_outbound",
              frame: { kind: "request", method: "session/new", params: "<any>" },
            },
            {
              type: "emit_inbound",
              frame: { kind: "response", method: "session/new", result: { sessionId } },
            },
            {
              type: "expect_outbound",
              frame: { kind: "request", method: "session/prompt", params: "<any>" },
            },
            update({ sessionUpdate: "session_info_update", title: "before steer" }),
            {
              type: "expect_outbound",
              frame: { kind: "request", method: "session/prompt", params: "<any>" },
            },
            // In request order this cancelled response settles the original prompt, which
            // the steer already superseded. Mis-paired onto the steer, it would end the
            // turn as cancelled instead.
            {
              type: "emit_inbound",
              frame: {
                kind: "response",
                method: "session/prompt",
                result: { stopReason: "cancelled" },
              },
            },
            update({
              sessionUpdate: "agent_message_chunk",
              messageId: "reply",
              content: { type: "text", text: "after the steer" },
            }),
            update({ sessionUpdate: "session_info_update", title: "steer output" }),
            {
              type: "emit_inbound",
              frame: {
                kind: "response",
                method: "session/prompt",
                result: { stopReason: "end_turn" },
              },
            },
            {
              type: "expect_outbound",
              frame: { kind: "request", method: "session/close", params: "<any>" },
            },
            {
              type: "emit_inbound",
              frame: { kind: "response", method: "session/close", result: {} },
            },
          ],
        } as never,
        ACP_TEST_DRIVER,
      );
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          steersWithPrompt: () => true,
          makeRuntime: makeAcpReplayRuntime({
            transcript,
            statusPath,
            scriptPath: yield* path.fromFileUrl(
              new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
            ),
            childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
            fileSystem,
          }),
          assertComplete: makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript),
        },
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: directory,
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-concurrent-prompts"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const until = (predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
        Effect.gen(function* () {
          const seen: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
          while (true) {
            const event = yield* Queue.take(events);
            seen.push(event);
            if (predicate(event)) return seen;
          }
        });
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
          ordinal: 1,
        }),
      );
      const started = yield* until(
        (event) =>
          event.type === "provider_thread.updated" &&
          event.providerThread.nativeMetadata?.title === "before steer",
      );
      const running = started.findLast((event) => event.type === "provider_turn.updated");
      if (running?.type !== "provider_turn.updated") throw new Error("Missing active turn");
      yield* runtime.steerTurn({
        threadId,
        runId: RunId.make(`run:${threadId}:1`),
        providerThread,
        providerTurnId: running.providerTurn.id,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("steer-concurrent-prompts"),
          text: "steer message",
          attachments: [],
        },
      });
      const terminalEvents = yield* until((event) => event.type === "turn.terminal");
      const terminal = terminalEvents.at(-1);
      assert.equal(terminal?.type === "turn.terminal" ? terminal.status : null, "completed");
      assert.isTrue(
        terminalEvents.some(
          (event) =>
            event.type === "message.updated" && event.message.text.includes("after the steer"),
        ),
        "the continued turn's output lands before the steer response settles it",
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
