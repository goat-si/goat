import { RunAttemptId } from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
import { CaptureEventQueue } from "./ClaudeAdapterV2.observations.testkit.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import { makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";
import {
  claudeSdkFrame,
  makeAssistantTextFrame,
  turnOneResult,
  WAKE_NATIVE_SESSION,
  wakeTaskStarted,
  wakeTurnInit,
} from "./ClaudeWakeFrames.testkit.ts";
import { makeWakeHarnessWithOptions } from "./ClaudeWakeHarness.testkit.ts";

// Only collectors opt into queue capture. A FIFO marker then acknowledges all
// provider events offered before it, after their collector callbacks finish.
vi.mock("effect/Queue", async (importOriginal) => {
  const actual = await importOriginal<typeof Queue>();
  return {
    ...actual,
    take: <A, E>(queue: Queue.Dequeue<A, E>) =>
      Effect.gen(function* () {
        const capture = yield* CaptureEventQueue;
        if (capture !== undefined && actual.isEnqueue<unknown, never>(queue)) {
          yield* capture((marker) => actual.offer(queue, marker));
        }
        return yield* actual.take(queue);
      }),
  };
});

const scheduleWakeupFrames = (input: {
  readonly toolUseId: string;
  readonly uuids: readonly [string, string];
  readonly toolInput: Record<string, unknown>;
  readonly scheduledFor: number;
}) => [
  claudeSdkFrame({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-6",
      id: `msg_${input.toolUseId}`,
      type: "message",
      role: "assistant",
      content: [
        { type: "tool_use", id: input.toolUseId, name: "ScheduleWakeup", input: input.toolInput },
      ],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    parent_tool_use_id: null,
    uuid: input.uuids[0],
    session_id: WAKE_NATIVE_SESSION,
  }),
  claudeSdkFrame({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: input.toolUseId, content: "Scheduled." }],
    },
    parent_tool_use_id: null,
    uuid: input.uuids[1],
    session_id: WAKE_NATIVE_SESSION,
    tool_use_result: {
      scheduledFor: input.scheduledFor,
      clampedDelaySeconds: 60,
      wasClamped: false,
    },
  }),
];

describe("warm process after the session changed outside GOAT", () => {
  const firstReply = "00000000-0000-4000-8000-000000000c01";
  const secondReply = "00000000-0000-4000-8000-000000000c02";
  const terminalPrompt = "00000000-0000-4000-8000-000000000c03";
  const terminalReply = "00000000-0000-4000-8000-000000000c04";
  const line = (entry: object) =>
    `${JSON.stringify({ isSidechain: false, sessionId: WAKE_NATIVE_SESSION, ...entry })}\n`;
  const entry = (
    type: "user" | "assistant",
    uuid: string,
    parentUuid: string | null,
    content: unknown,
    extra?: object,
  ) => line({ type, uuid, parentUuid, message: { role: type, content }, ...extra });
  const goatTurn = (promptUuid: string) =>
    entry("user", promptUuid, null, "Request 1") +
    entry("assistant", firstReply, promptUuid, [{ type: "text", text: "Working." }]) +
    entry("assistant", secondReply, firstReply, [{ type: "text", text: "Done." }]);
  const terminalExchange =
    entry("user", terminalPrompt, secondReply, "Typed in the terminal") +
    entry("assistant", terminalReply, terminalPrompt, [{ type: "text", text: "Answered." }]);

  // Streams one GOAT turn of two reply blocks, writes the transcript, then starts the next turn.
  const nextTurnAfter = Effect.fnUntraced(function* (input: {
    readonly transcript: ((promptUuid: string) => string) | null;
    readonly backgroundShell?: boolean;
    readonly scheduledWakeup?: boolean;
    readonly wakeFiresDuringRead?: boolean;
    readonly pinnedHead?: string;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-claude-stale-" });
    const projectDir = path.join(configDir, "projects", "-workspace");
    yield* fileSystem.makeDirectory(projectDir, { recursive: true });
    const transcriptOpened = yield* Deferred.make<void>();
    const releaseTranscript = yield* Deferred.make<void>();
    const heldFileSystem: FileSystem.FileSystem = {
      ...fileSystem,
      open: (filePath, options) =>
        filePath.endsWith(".jsonl")
          ? Deferred.succeed(transcriptOpened, undefined).pipe(
              Effect.andThen(Deferred.await(releaseTranscript)),
              Effect.andThen(fileSystem.open(filePath, options)),
            )
          : fileSystem.open(filePath, options),
    };
    const harness = yield* makeWakeHarnessWithOptions({
      environment: { CLAUDE_CONFIG_DIR: configDir },
      freshQueueOnReopen: true,
    }).pipe(
      input.wakeFiresDuringRead === true
        ? Effect.provideService(FileSystem.FileSystem, heldFileSystem)
        : (effect) => effect,
    );
    const providerThread =
      input.pinnedHead === undefined
        ? harness.providerThread
        : {
            ...harness.providerThread,
            nativeConversationHeadRef: {
              driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
              nativeId: input.pinnedHead,
              strength: "weak" as const,
            },
          };
    const now = yield* DateTime.now;
    const turn = (ordinal: number) =>
      makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread,
        now,
        attemptId: RunAttemptId.make(`attempt-stale-process:${ordinal}`),
        text: `Request ${ordinal}`,
        attachments: [],
        providerTurnOrdinal: ordinal,
      });
    yield* harness.runtime.startTurn(turn(1));
    if (input.backgroundShell === true) yield* harness.offerAndWait(wakeTaskStarted);
    if (input.scheduledWakeup === true || input.wakeFiresDuringRead === true) {
      for (const frame of scheduleWakeupFrames({
        toolUseId: "toolu_stale_process_wakeup",
        uuids: ["00000000-0000-4000-8000-000000000c05", "00000000-0000-4000-8000-000000000c06"],
        toolInput: { delaySeconds: 3600, prompt: "check", reason: "wake", noop: false },
        scheduledFor: DateTime.toEpochMillis(now) + 3_600_000,
      })) {
        yield* harness.offerAndWait(frame);
      }
    }
    yield* harness.offerAndWait(makeAssistantTextFrame({ uuid: firstReply, text: "Working." }));
    yield* harness.offerAndWait(makeAssistantTextFrame({ uuid: secondReply, text: "Done." }));
    yield* harness.offerAndWait(turnOneResult);
    assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "completed");
    if (input.transcript !== null) {
      yield* fileSystem.writeFileString(
        path.join(projectDir, `${WAKE_NATIVE_SESSION}.jsonl`),
        input.transcript(harness.promptUuid(0)),
      );
    }
    if (input.wakeFiresDuringRead !== true) {
      yield* harness.runtime.startTurn(turn(2));
      return harness;
    }
    yield* TestClock.adjust("1 hour");
    const nextTurn = yield* Effect.forkChild(harness.runtime.startTurn(turn(2)));
    yield* Deferred.await(transcriptOpened);
    yield* harness.offerAndWait(wakeTurnInit);
    yield* Deferred.succeed(releaseTranscript, undefined);
    yield* Fiber.join(nextTurn);
    return harness;
  });

  it.effect.each([
    {
      name: "the session transcript gained messages outside GOAT",
      transcript: (promptUuid: string) => goatTurn(promptUuid) + terminalExchange,
    },
    {
      // The terminal's rows alone are longer than the tail GOAT reads first.
      name: "a long terminal exchange followed its last message",
      transcript: (promptUuid: string) =>
        goatTurn(promptUuid) +
        entry("user", terminalPrompt, secondReply, "x".repeat(1_200_000)) +
        entry("assistant", terminalReply, terminalPrompt, [
          { type: "text", text: "y".repeat(1_200_000) },
        ]),
    },
  ])("replaces a warm process when $name", (row) =>
    Effect.gen(function* () {
      const harness = yield* nextTurnAfter(row);
      assert.lengthOf(harness.processQueues, 2, "the next turn must open a fresh process");
      assert.equal(harness.getOpenedOptions()?.resume, WAKE_NATIVE_SESSION);
      assert.isUndefined(harness.getOpenedOptions()?.resumeSessionAt);
    }).pipe(Effect.scoped, Effect.provide(layerClaudeAdapterTest)),
  );

  it.effect.each([
    {
      name: "the file lags the stream",
      transcript: (promptUuid: string) =>
        entry("user", promptUuid, null, "Request 1") +
        entry("assistant", firstReply, promptUuid, [{ type: "text", text: "Working." }]),
    },
    {
      name: "only bookkeeping follows GOAT's reply",
      transcript: (promptUuid: string) =>
        goatTurn(promptUuid) +
        line({
          type: "system",
          subtype: "turn_duration",
          uuid: "sys-1",
          parentUuid: secondReply,
        }) +
        line({ type: "last-prompt", leafUuid: secondReply }) +
        entry("assistant", "side-1", secondReply, [{ type: "text", text: "x" }], {
          isSidechain: true,
        }) +
        entry("user", "meta-1", secondReply, "Caveat", { isMeta: true }) +
        entry("user", "stop-1", secondReply, "[Request interrupted by user]") +
        JSON.stringify({ type: "user", uuid: "half-written", parentUuid: secondReply }).slice(
          0,
          30,
        ),
    },
    { name: "there is no transcript", transcript: null },
    {
      name: "a pinned head decides where to resume",
      transcript: (promptUuid: string) => goatTurn(promptUuid) + terminalExchange,
      pinnedHead: firstReply,
    },
    {
      name: "replacing it would end background work",
      transcript: (promptUuid: string) => goatTurn(promptUuid) + terminalExchange,
      backgroundShell: true,
    },
    {
      name: "replacing it would cancel a scheduled wakeup",
      transcript: (promptUuid: string) => goatTurn(promptUuid) + terminalExchange,
      scheduledWakeup: true,
    },
    {
      name: "its scheduled wakeup fires while the transcript is read",
      transcript: (promptUuid: string) => goatTurn(promptUuid) + terminalExchange,
      wakeFiresDuringRead: true,
    },
    {
      // Longer than the tail GOAT reads, and the process's own messages are not written yet.
      name: "a long transcript's tail holds none of its messages",
      transcript: () =>
        entry("user", "old-1", null, "x".repeat(1_200_000)) +
        entry("assistant", "old-2", "old-1", [{ type: "text", text: "y".repeat(1_200_000) }]),
    },
  ])("keeps the warm process when $name", (row) =>
    Effect.gen(function* () {
      const harness = yield* nextTurnAfter(row);
      assert.lengthOf(harness.processQueues, 1);
      assert.lengthOf(harness.offeredMessages, 2);
    }).pipe(Effect.scoped, Effect.provide(layerClaudeAdapterTest)),
  );
});
