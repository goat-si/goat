import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ThreadId,
  type OrchestrationV2Command,
  type ProviderReplayEntry,
  type ProviderReplayTranscript,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import {
  readProviderReplayTranscript,
  materializeReplayTranscriptWorkspace,
} from "@goat/provider-testing/replayTranscript";
import { checkpointWorkspace } from "@goat/provider-testing/replayWorkspace";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { CodexOrchestratorReplayHarness } from "../Adapters/CodexAdapterV2.testkit.ts";
import { ClaudeOrchestratorReplayHarness } from "../Adapters/ClaudeAdapterV2.testkit.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import {
  materializeFixtureInput,
  CLAUDE_MODEL_SELECTION,
  CODEX_MODEL_SELECTION,
  SIMPLE_PROMPT,
} from "./fixtures/shared.ts";
import {
  runOrchestratorV2ProviderReplayScenario,
  type OrchestratorV2ProviderReplayHarness,
} from "./ProviderReplayHarness.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "./ReplayRuntimeInstructions.ts";

function receiptFrames(
  raw: ProviderReplayTranscript,
  driver: "codex" | "claudeAgent",
  mixed = false,
) {
  const entries: ProviderReplayEntry[] = [];
  let inserted = false;
  for (const entry of raw.entries) {
    if (entry.type === "runtime_exit") {
      entries.push(entry);
      continue;
    }
    if (
      driver === "codex" &&
      entry.type === "expect_outbound" &&
      Predicate.isObject(entry.frame) &&
      entry.frame.method === "thread/start" &&
      Predicate.isObject(entry.frame.params) &&
      Predicate.isObject(entry.frame.params.config)
    ) {
      entries.push({
        ...entry,
        frame: {
          ...entry.frame,
          params: {
            ...entry.frame.params,
            config: {
              ...entry.frame.params.config,
              "features.default_mode_request_user_input": false,
            },
          },
        },
      });
      continue;
    }
    if (
      driver === "claudeAgent" &&
      entry.type === "expect_outbound" &&
      Predicate.isObject(entry.frame) &&
      entry.frame.type === "query.open" &&
      Predicate.isObject(entry.frame.options)
    ) {
      entries.push({
        ...entry,
        frame: {
          ...entry.frame,
          options: { ...entry.frame.options, disallowedTools: ["Agent", "Task"] },
        },
      });
      continue;
    }
    const frame =
      entry.type === "emit_inbound" && Predicate.isObject(entry.frame) ? entry.frame : null;
    if (driver === "claudeAgent" && frame?.type === "assistant" && !inserted) {
      inserted = true;
      if (mixed) {
        entries.push({
          ...entry,
          frame: {
            ...frame,
            message: {
              ...(Predicate.isObject(frame.message) ? frame.message : {}),
              content: [
                { type: "text", text: "Checking\n" },
                {
                  type: "tool_use",
                  id: "receipt-tool",
                  name: "Read",
                  input: { file_path: "/workspace/a" },
                },
              ],
            },
          },
        });
        continue;
      }
      const stream = (event: unknown): ProviderReplayEntry => ({
        type: "emit_inbound",
        frame: {
          type: "stream_event",
          event,
          uuid: "receipt-stream",
          session_id: frame.session_id,
          parent_tool_use_id: null,
        },
      });
      entries.push(
        stream({ type: "message_start", message: { id: "receipt-native-message" } }),
        stream({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
        stream({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Checking\n" },
        }),
        {
          type: "emit_inbound",
          frame: {
            ...frame,
            uuid: "receipt-barrier",
            message: {
              id: "receipt-native-message",
              model: "claude-sonnet-4-6",
              content: [{ type: "thinking", thinking: "Barrier" }],
            },
          },
        },
      );
      continue;
    }
    if (
      driver === "codex" &&
      frame?.method === "item/agentMessage/delta" &&
      Predicate.isObject(frame.params) &&
      !inserted
    ) {
      inserted = true;
      entries.push(
        { ...entry, frame: { ...frame, params: { ...frame.params, delta: "Checking\n" } } },
        {
          type: "emit_inbound",
          frame: {
            method: "item/completed",
            params: {
              threadId: frame.params.threadId,
              turnId: frame.params.turnId,
              completedAtMs: 1790295407000,
              item: { type: "reasoning", id: "receipt-barrier", summary: ["Barrier"], content: [] },
            },
          },
        },
      );
      continue;
    }
    if (
      driver === "codex" &&
      frame?.method === "item/completed" &&
      Predicate.isObject(frame.params) &&
      Predicate.isObject(frame.params.item) &&
      frame.params.item.type === "agentMessage"
    )
      continue;
    if (driver === "codex" && frame?.method === "item/agentMessage/delta" && inserted) continue;
    if (
      (driver === "claudeAgent" && frame?.type === "result") ||
      (driver === "codex" && frame?.method === "turn/completed")
    )
      entries.push({ ...entry, label: "receipt-release" });
    else entries.push(entry);
  }
  if (!inserted) throw new Error("Missing assistant frame in receipt fixture.");
  return { ...raw, entries };
}

function receiptReplay<T extends ProviderReplayTranscript, E>(
  driver: "codex" | "claudeAgent",
  harness: OrchestratorV2ProviderReplayHarness<T, E>,
  mixed = false,
) {
  return Effect.gen(function* () {
    const file = driver === "codex" ? "codex" : "claude";
    const raw = yield* readProviderReplayTranscript(
      new URL(`./fixtures/simple/${file}_transcript.ndjson`, import.meta.url),
    ).pipe(Effect.provide(NodeServices.layer));
    const modelSelection = driver === "codex" ? CODEX_MODEL_SELECTION : CLAUDE_MODEL_SELECTION;
    const workspace = yield* checkpointWorkspace("receipt-" + driver);
    const transcript = yield* harness.decodeTranscript(
      materializeReplayTranscriptRuntimeInstructions(
        materializeReplayTranscriptWorkspace(receiptFrames(raw, driver, mixed), workspace),
        {
          driver: ProviderDriverKind.make(driver),
          model: modelSelection.model,
        },
      ),
    );
    const materialized = yield* materializeFixtureInput({
      scenario: "receipt-" + driver,
      fixtureInput: { steps: [{ type: "message", text: SIMPLE_PROMPT }] },
      driver: ProviderDriverKind.make(driver),
      modelSelection,
    }).pipe(Effect.provide(IdAllocator.layer));
    const threadId = ThreadId.make("goat-bot-session:replay:" + driver);
    const command = (value: OrchestrationV2Command): OrchestrationV2Command =>
      "threadId" in value ? { ...value, threadId } : value;
    const commands = materialized.commands.map(command);
    const runId = (yield* IdAllocator.IdAllocatorV2).derive.run({ threadId, ordinal: 1 });
    const result = yield* runOrchestratorV2ProviderReplayScenario(
      {
        name: "receipt-persistence-" + driver,
        transcript,
        commands,
        projectionThreadIds: [threadId],
        runtimePolicyOverride: { cwd: workspace },
        steps: [
          ...commands.map((value) => ({
            type: "dispatch" as const,
            command: value,
            await: value.type !== "message.dispatch",
          })),
          {
            type: "await_run_turn_item",
            threadId,
            runId,
            itemType: mixed ? "dynamic_tool" : "reasoning",
          },
          ...(driver === "claudeAgent"
            ? [{ type: "advance_clock" as const, duration: "20 seconds" as const }]
            : []),
          { type: "release_replay_gate", label: "receipt-release" },
          { type: "await_thread_idle", threadId },
        ],
      },
      harness,
    );
    const text = result.domainEvents.findIndex(
      (event) =>
        event.type === "turn-item.updated" &&
        event.payload.type === "assistant_message" &&
        event.payload.streaming === !mixed &&
        event.payload.text === "Checking\n",
    );
    const barrier = result.domainEvents.findIndex((event) =>
      mixed
        ? event.type === "node.updated" && event.payload.kind === "tool_call"
        : event.type === "turn-item.updated" && event.payload.type === "reasoning",
    );
    assert.isAtLeast(text, 0, "the receipt must persist while native text is still open");
    assert.isAbove(barrier, text, "the receipt commits before the later native barrier");
  }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
}

it.effect("persists Codex's receipt before completion in a native replay", () =>
  receiptReplay("codex", CodexOrchestratorReplayHarness),
);
it.effect(
  "persists Claude's receipt with its text block held open for twenty TestClock seconds",
  () => receiptReplay("claudeAgent", ClaudeOrchestratorReplayHarness),
);
it.effect("persists text before the tool from one mixed Claude native frame", () =>
  receiptReplay("claudeAgent", ClaudeOrchestratorReplayHarness, true),
);
