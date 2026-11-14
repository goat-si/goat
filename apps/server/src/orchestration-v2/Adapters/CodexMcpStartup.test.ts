import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import { assert, describe, it } from "@effect/vitest";
import { RunAttemptId } from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import { makeCodexReplayTurn, makeCodexReplayTranscript } from "./CodexReplay.testkit.ts";
import { makeCodexTestTurnInput } from "./CodexAdapterV2.testkit.ts";
import { codexReplayPreamble, makeCodexReplayHarness } from "./CodexAdapterV2.replay.testkit.ts";

describe("Codex MCP startup", () => {
  it.effect.each(["before", "during"] as const)(
    "surfaces a user MCP server that fails to start %s the turn",
    (timing) =>
      Effect.scoped(
        Effect.gen(function* () {
          const nativeThreadId = "mcp-startup-failed-thread";
          const nativeTurnId = "mcp-startup-failed-turn";
          const startupError =
            "MCP client for `example_mcp` failed to start: MCP startup failed: handshaking with MCP server failed";
          const startup: Array<CodexReplay.CodexAppServerReplayEntry> = [
            {
              type: "emit_inbound",
              label: "mcp-failed-without-thread",
              frame: {
                method: "mcpServer/startupStatus/updated",
                params: {
                  threadId: null,
                  name: "example_mcp",
                  status: "failed",
                  error: startupError,
                },
              },
            },
            {
              type: "emit_inbound",
              label: "mcp-starting",
              frame: {
                method: "mcpServer/startupStatus/updated",
                params: {
                  threadId: nativeThreadId,
                  name: "example_mcp",
                  status: "starting",
                  error: null,
                  failureReason: null,
                },
              },
            },
            {
              type: "emit_inbound",
              label: "mcp-failed",
              frame: {
                method: "mcpServer/startupStatus/updated",
                params: {
                  threadId: nativeThreadId,
                  name: "example_mcp",
                  status: "failed",
                  error: startupError,
                  failureReason: null,
                },
              },
            },
          ];
          const preamble = codexReplayPreamble({
            nativeThreadId,
            nativeTurnId,
            prompt: "use example_mcp",
          });
          const turnStart = preamble.findIndex(
            (entry) => entry.type === "expect_outbound" && entry.label === "turn/start",
          );
          const transcript = makeCodexReplayTranscript({
            scenario: "codex-mcp-startup-failed",
            entries: [
              ...(timing === "before"
                ? [...preamble.slice(0, turnStart), ...startup, ...preamble.slice(turnStart)]
                : [...preamble, ...startup]),
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
              attemptId: RunAttemptId.make("mcp-startup-failed-attempt"),
              text: "use example_mcp",
            }),
          );
          yield* harness.firstTerminal;
          const surfaced = harness.events.filter((event) => {
            const serialized = JSON.stringify(event);
            return serialized.includes("example_mcp") && serialized.includes("failed to start");
          });
          assert.lengthOf(surfaced, 1);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              MemoryDerivedCache.layer,
              McpProviderSessions.layer,
              NodeServices.layer,
              NodeCrypto.layer,
            ),
          ),
        ),
      ),
  );
});
