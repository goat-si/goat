import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunAttemptId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import { makeCodexReplayTurn, makeCodexReplayTranscript } from "./CodexReplay.testkit.ts";
import { makeCodexTestTurnInput } from "./CodexAdapterV2.testkit.ts";
import { codexReplayPreamble, makeCodexReplayHarness } from "./CodexAdapterV2.replay.testkit.ts";

const BG_SCENARIO = "codex-bg-exec-wake";
const BG_NATIVE_THREAD = "native-codex-bg-thread";
const BG_NATIVE_TURN = "native-codex-bg-turn";
const BG_COMMAND_ITEM = "call-codex-bg-command";
const BG_COMMAND = "sleep 20 && echo CODEX_BG_WAKE_DONE";
const BG_PROMPT = "Start the sleep in the background and reply STARTED.";
const backgroundCommandItem = (status: "inProgress" | "completed"): Record<string, unknown> => ({
  type: "commandExecution",
  id: BG_COMMAND_ITEM,
  command: BG_COMMAND,
  cwd: "/workspace",
  processId: "4242",
  source: "unifiedExecStartup",
  status,
  commandActions: [{ type: "unknown", command: BG_COMMAND }],
  aggregatedOutput: status === "completed" ? "CODEX_BG_WAKE_DONE\n" : null,
  exitCode: status === "completed" ? 0 : null,
  durationMs: status === "completed" ? 25_000 : null,
});
const backgroundExecTranscript = makeCodexReplayTranscript({
  scenario: BG_SCENARIO,
  entries: [
    ...codexReplayPreamble({
      nativeThreadId: BG_NATIVE_THREAD,
      nativeTurnId: BG_NATIVE_TURN,
      prompt: BG_PROMPT,
    }),
    {
      type: "emit_inbound",
      label: "item/started/command",
      frame: {
        method: "item/started",
        params: {
          item: backgroundCommandItem("inProgress"),
          threadId: BG_NATIVE_THREAD,
          turnId: BG_NATIVE_TURN,
          startedAtMs: 1782622440500,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "item/completed/root-answer",
      frame: {
        method: "item/completed",
        params: {
          item: {
            type: "agentMessage",
            id: "root-answer-bg",
            text: "STARTED",
            phase: "final_answer",
            memoryCitation: null,
          },
          threadId: BG_NATIVE_THREAD,
          turnId: BG_NATIVE_TURN,
          completedAtMs: 1782622441000,
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/completed",
      frame: {
        method: "turn/completed",
        params: {
          threadId: BG_NATIVE_THREAD,
          turn: makeCodexReplayTurn({ id: BG_NATIVE_TURN, status: "completed" }),
        },
      },
    },
    {
      type: "emit_inbound",
      label: "item/completed/command-late",
      afterMs: 30_000,
      frame: {
        method: "item/completed",
        params: {
          item: backgroundCommandItem("completed"),
          threadId: BG_NATIVE_THREAD,
          turnId: BG_NATIVE_TURN,
          completedAtMs: 1782622465500,
        },
      },
    },
  ],
});

it.effect("marks a root command it wakes the agent for once the command finishes", () =>
  Effect.gen(function* () {
    const harness = yield* makeCodexReplayHarness({
      ...backgroundExecTranscript,
      entries: backgroundExecTranscript.entries.map((entry) =>
        entry.type === "emit_inbound" && entry.label === "item/completed/command-late"
          ? { ...entry, afterMs: 0 }
          : entry,
      ),
    });
    yield* harness.runtime.startTurn(
      makeCodexTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("attempt-command-completion-wake"),
        text: BG_PROMPT,
      }),
    );
    const commands = () =>
      harness.events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "command_execution"
          ? [[event.turnItem.status, event.turnItem.completionWake]]
          : [],
      );
    yield* harness.awaitUntil(
      () => harness.continuationRequests.length === 1 && commands().length === 2,
      "command completion wake",
    );
    // Restart recovery reads this to keep the wake the restart cut.
    assert.deepEqual(commands(), [
      ["running", "always"],
      ["completed", "always"],
    ]);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        McpProviderSessions.layer,
        NodeServices.layer,
        MemoryDerivedCache.layer,
      ),
    ),
  ),
);
