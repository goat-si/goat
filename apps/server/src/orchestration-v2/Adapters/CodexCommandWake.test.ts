import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, MessageId, ProjectId, RunAttemptId, ThreadId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";
import {
  makeCodexReplayTurn,
  makeCodexReplayTranscript,
  withConfigReads,
} from "./CodexReplay.testkit.ts";
import * as CodexAdapterV2Testkit from "./CodexAdapterV2.testkit.ts";
import { CODEX_TEST_MODEL_SELECTION, makeCodexTestTurnInput } from "./CodexAdapterV2.testkit.ts";
import { codexReplayPreamble, makeCodexReplayHarness } from "./CodexAdapterV2.replay.testkit.ts";

const replayTranscriptJson = Schema.fromJsonString(CodexReplay.CodexAppServerReplayTranscript);
const decodeReplayTranscriptJson = Schema.decodeUnknownEffect(replayTranscriptJson);
const encodeReplayTranscriptJson = Schema.encodeEffect(replayTranscriptJson);
const encodeStringJson = Schema.encodeEffect(Schema.fromJsonString(Schema.String));

const layerAdapterTest = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
  NodeCrypto.layer,
  MemoryDerivedCache.layer,
);

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
  }).pipe(Effect.scoped, Effect.provide(layerAdapterTest)),
);

it.effect("settles a command Codex never completed once its terminal is gone", () =>
  Effect.gen(function* () {
    const settled = yield* Deferred.make<void>();
    const harness = yield* makeCodexReplayHarness(
      makeCodexReplayTranscript({
        scenario: "codex-bg-missing-completion",
        entries: [
          ...backgroundExecTranscript.entries.slice(0, -1),
          {
            type: "expect_outbound",
            label: "list-background-terminals",
            frame: {
              id: 4,
              method: "thread/backgroundTerminals/list",
              params: { threadId: BG_NATIVE_THREAD },
            },
          },
          {
            type: "emit_inbound",
            label: "list-background-terminals",
            frame: { id: 4, result: { data: [], nextCursor: null } },
          },
          // The terminal can leave the list before Codex reports the command's result.
          {
            type: "emit_inbound",
            label: "item/completed/command-late",
            frame: {
              method: "item/completed",
              params: {
                item: backgroundCommandItem("completed"),
                threadId: BG_NATIVE_THREAD,
                turnId: BG_NATIVE_TURN,
              },
            },
          },
        ],
      }),
      (event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.type === "command_execution" &&
        event.turnItem.status === "completed"
          ? Deferred.succeed(settled, undefined)
          : Effect.void,
    );
    yield* harness.runtime.startTurn(
      makeCodexTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("attempt-codex-bg-missing-completion"),
        text: BG_PROMPT,
      }),
    );
    yield* Deferred.await(settled);
    yield* harness.awaitUntil(
      () => harness.continuationRequests.length === 1,
      "continuation request after late completion",
    );
    assert.deepEqual(
      harness.events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "command_execution"
          ? [event.turnItem.status]
          : [],
      ),
      ["running", "cancelled", "completed"],
    );
    assert.deepEqual(
      harness.terminalEvents().map((event) => event.status),
      ["completed"],
    );
    assert.isFalse(yield* harness.hasPendingBackgroundWork);
    assert.lengthOf(harness.continuationRequests, 1);
  }).pipe(Effect.scoped, Effect.provide(layerAdapterTest)),
);

it.effect.each([
  {
    name: "a sibling command finishes first",
    other: { processId: "4243" },
    live: ["4243"],
    expected: ["running", "cancelled", "completed"],
  },
  {
    name: "its process id is unknown and a terminal is unclaimed",
    other: undefined,
    live: ["9999"],
    expected: ["running", "completed"],
  },
] as const)("routes a late command result when $name", ({ other, live, expected }) =>
  Effect.gen(function* () {
    const inbound = (label: string, method: string, item: Record<string, unknown>) => ({
      type: "emit_inbound" as const,
      label,
      frame: { method, params: { item, threadId: BG_NATIVE_THREAD, turnId: BG_NATIVE_TURN } },
    });
    const sibling = (status: "inProgress" | "completed") => ({
      ...backgroundCommandItem(status),
      id: "call-codex-bg-other",
      processId: other?.processId ?? null,
    });
    const startedCommand = backgroundExecTranscript.entries.at(-4);
    assert.isDefined(startedCommand);
    const [, ...settle] = backgroundExecTranscript.entries.slice(-4, -1);
    const settled = yield* Deferred.make<void>();
    const harness = yield* makeCodexReplayHarness(
      makeCodexReplayTranscript({
        scenario: `codex-bg-late-result-${other === undefined ? "no-pid" : "sibling"}`,
        entries: [
          ...backgroundExecTranscript.entries.slice(0, -4),
          other === undefined
            ? inbound("item/started/command", "item/started", {
                ...backgroundCommandItem("inProgress"),
                processId: null,
              })
            : startedCommand,
          ...(other === undefined
            ? []
            : [inbound("item/started/other", "item/started", sibling("inProgress"))]),
          ...settle,
          {
            type: "expect_outbound",
            label: "list-background-terminals",
            frame: {
              id: 4,
              method: "thread/backgroundTerminals/list",
              params: { threadId: BG_NATIVE_THREAD },
            },
          },
          {
            type: "emit_inbound",
            label: "list-background-terminals",
            frame: {
              id: 4,
              result: { data: live.map((processId) => ({ processId })), nextCursor: null },
            },
          },
          ...(other === undefined
            ? []
            : [inbound("item/completed/other", "item/completed", sibling("completed"))]),
          inbound(
            "item/completed/command-late",
            "item/completed",
            backgroundCommandItem("completed"),
          ),
        ],
      }),
      (event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.nativeItemRef?.nativeId === BG_COMMAND_ITEM &&
        event.turnItem.status === "completed"
          ? Deferred.succeed(settled, undefined)
          : Effect.void,
    );
    yield* harness.runtime.startTurn(
      makeCodexTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("attempt-codex-bg-late-result"),
        text: BG_PROMPT,
      }),
    );
    yield* Deferred.await(settled);
    assert.deepEqual(
      harness.events.flatMap((event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.nativeItemRef?.nativeId === BG_COMMAND_ITEM
          ? [event.turnItem.status]
          : [],
      ),
      [...expected],
    );
  }).pipe(Effect.scoped, Effect.provide(layerAdapterTest)),
);

it.effect("records a command's late result after its run stopped listening", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "goat-bg-late-result-workspace-" });
    const transcript = makeCodexReplayTranscript({
      scenario: "codex-bg-late-result",
      entries: [
        ...backgroundExecTranscript.entries.slice(0, -1),
        {
          type: "expect_outbound",
          label: "list-background-terminals",
          frame: {
            id: 4,
            method: "thread/backgroundTerminals/list",
            params: { threadId: BG_NATIVE_THREAD },
          },
        },
        {
          type: "emit_inbound",
          label: "list-background-terminals",
          frame: { id: 4, result: { data: [], nextCursor: null } },
        },
        {
          type: "emit_inbound",
          label: "item/completed/command-late",
          frame: {
            method: "item/completed",
            params: {
              item: backgroundCommandItem("completed"),
              threadId: BG_NATIVE_THREAD,
              turnId: BG_NATIVE_TURN,
            },
          },
        },
      ],
    });
    const localTranscript = withConfigReads(
      yield* decodeReplayTranscriptJson(
        (yield* encodeReplayTranscriptJson(transcript)).replaceAll(
          yield* encodeStringJson("/workspace"),
          yield* encodeStringJson(cwd),
        ),
      ),
      true,
      "Background late result",
    );
    const released = yield* Deferred.make<void>();
    const replayDriver = yield* CodexReplay.makeReplayDriver(localTranscript, {
      beforeEmitInbound: (entry) =>
        entry.label === "item/completed/command-late" ? Deferred.await(released) : Effect.void,
    });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    for (const args of [
      ["init", "--quiet"],
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "--quiet",
        "-m",
        "Initial commit",
      ],
    ]) {
      assert.equal(Number(yield* spawner.exitCode(ChildProcess.make("git", args, { cwd }))), 0);
    }
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make("thread:background-late-result");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-background-late-result"),
        threadId,
        projectId: ProjectId.make("project:background-late-result"),
        title: "Background late result",
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
        createdBy: "user",
        creationSource: "web",
      });
      const commandStatus = (status: string) =>
        orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "turn-item.updated" &&
              event.payload.type === "command_execution" &&
              event.payload.status === status,
          ),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
      const cancelled = yield* commandStatus("cancelled");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("start-background-late-result"),
        threadId,
        messageId: MessageId.make("message:background-late-result"),
        text: BG_PROMPT,
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      });
      yield* worker.drain();
      yield* Fiber.join(cancelled);
      yield* worker.drain();
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
        "completed",
      );
      assert.deepEqual((yield* orchestrator.getThreadShell(threadId))?.pendingBackgroundTasks, []);
      const completed = yield* commandStatus("completed");
      yield* Deferred.succeed(released, undefined);
      yield* Fiber.join(completed);
      yield* worker.drain();
      assert.isNull((yield* Ref.get(replayDriver.state)).failure);
      assert.deepEqual(
        (yield* orchestrator.getThreadProjection(threadId)).turnItems.flatMap((item) =>
          item.type === "command_execution" ? [[item.status, item.exitCode, item.output]] : [],
        ),
        [["completed", 0, "CODEX_BG_WAKE_DONE\n"]],
      );
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry(
          { name: "codex-background-late-result", runtimePolicyOverride: { cwd } },
          CodexAdapterV2Testkit.layer({ transcript: localTranscript, driver: replayDriver }),
          { runEffectWorker: false },
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
