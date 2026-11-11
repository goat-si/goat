import { assert } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { PiRpcRecord } from "../rpc.ts";

const decodeJsonLine = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const FAKE_SESSION_FILE = "/fake/.pi/agent/sessions/--workspace--/0001_abc.jsonl";
/** Deliberately outside the valid pid range so a group-kill can never land. */
export const FAKE_PID = 999_999_999;

export interface FakePi {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly emit: (record: PiRpcRecord, chunkBytes?: number) => Effect.Effect<void>;
  readonly takeRequest: (type: string) => Effect.Effect<PiRpcRecord>;
  readonly queueEntries: (data: unknown) => void;
  readonly queueMessages: (data: unknown) => void;
  readonly vetoNextSwitch: () => void;
  readonly queueState: (data: Record<string, unknown>) => void;
  readonly setStreaming: (streaming: boolean) => void;
  readonly setCompacting: (compacting: boolean) => void;
  readonly deferNextState: () => void;
  readonly resolveDeferredState: (data: unknown) => Effect.Effect<void>;
  readonly failNextState: () => void;
  readonly failNextPrompt: () => void;
  readonly failNextThinking: () => void;
  readonly deferNextLifecycle: (type: "switch_session" | "new_session" | "fork" | "abort") => void;
  readonly deferNextModelSelection: () => void;
  readonly queueModels: (models: ReadonlyArray<unknown>) => void;
  readonly vetoNextNewSession: () => void;
  readonly allRequests: () => ReadonlyArray<PiRpcRecord>;
  readonly promptThinkingLevels: ReadonlyArray<string>;
  readonly promptModels: ReadonlyArray<string>;
  readonly queueStats: (data: unknown) => void;
  /** Pi before 0.84.4 answers clear_queue as an unknown command. */
  readonly setClearQueue: (
    result:
      | { readonly steering: ReadonlyArray<string>; readonly followUp: ReadonlyArray<string> }
      | "unknown_command",
  ) => void;
  readonly closeStdout: Effect.Effect<void>;
  readonly lastSpawn: () => {
    readonly args: ReadonlyArray<string>;
    readonly env: NodeJS.ProcessEnv;
  };
}

/** Pi omits `model` when none is selected and `sessionName` until one is set. */
const recordedIdleState = (sessionFile: string) => ({
  thinkingLevel: "high",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  sessionFile,
  sessionId: "00000000-0000-4000-8000-000000000002",
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
});

/** Pi 1.4.0 rejects every prompt while compaction runs, including steers. */
export const PI_COMPACTING_PROMPT_ERROR =
  "Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.";

export const makeFakePi: Effect.Effect<FakePi> = Effect.gen(function* () {
  const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const requests = yield* Queue.unbounded<PiRpcRecord>();
  const entriesQueue: Array<unknown> = [];
  const messagesQueue: Array<unknown> = [];
  const stateQueue: Array<Record<string, unknown>> = [];
  const statsQueue: Array<unknown> = [];
  const allRequests: Array<PiRpcRecord> = [];
  let deferState = false;
  let deferredStateRequest: PiRpcRecord | undefined;
  let failState = false;
  let failPrompt = false;
  let failThinking = false;
  let vetoSwitch = false;
  let vetoNewSession = false;
  let deferredLifecycle: string | undefined;
  let sessionFile = FAKE_SESSION_FILE;
  let sessionGeneration = 0;
  let models: ReadonlyArray<unknown> = [];
  let isStreaming: boolean | null = null;
  let isCompacting = false;
  let clearQueue: Parameters<FakePi["setClearQueue"]>[0] = { steering: [], followUp: [] };
  let stdinBuffer = "";
  let thinkingLevel = "high";
  const promptThinkingLevels: Array<string> = [];
  const promptModels: Array<string> = [];
  let currentModel = "default";

  const emit = Effect.fnUntraced(function* (record: PiRpcRecord, chunkBytes?: number) {
    const bytes = new TextEncoder().encode(`${encodeJsonLine(record)}\n`);
    const size = chunkBytes ?? bytes.byteLength;
    for (let offset = 0; offset < bytes.byteLength; offset += size) {
      yield* Queue.offer(stdout, bytes.subarray(offset, offset + size));
    }
  });

  const respondTo = (record: PiRpcRecord): PiRpcRecord | null => {
    if (
      typeof record["id"] !== "string" &&
      !(record["type"] === "prompt" && (isStreaming !== null || isCompacting))
    )
      return null;
    const base = {
      type: "response",
      id: record["id"],
      command: String(record["type"]),
      success: true,
    };
    switch (record["type"]) {
      case "get_state":
        if (failState) {
          failState = false;
          return { ...base, success: false, error: "state unavailable" };
        }
        return {
          ...base,
          data: {
            ...recordedIdleState(sessionFile),
            isStreaming: isStreaming ?? false,
            ...stateQueue.shift(),
          },
        };
      case "prompt":
        if (failPrompt) {
          failPrompt = false;
          return { ...base, success: false, error: "prompt unavailable" };
        }
        if (isCompacting) {
          return { ...base, success: false, error: PI_COMPACTING_PROMPT_ERROR };
        }
        if (isStreaming && record["streamingBehavior"] === undefined) {
          return {
            ...base,
            success: false,
            error:
              "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
          };
        }
        return base;
      case "get_available_models":
        return { ...base, data: { models } };
      case "set_model":
        // Pi reapplies the target model's configured thinking default.
        thinkingLevel = "low";
        currentModel = `${String(record["provider"])}/${String(record["modelId"])}`;
        return base;
      case "set_thinking_level":
        if (failThinking) {
          failThinking = false;
          return { ...base, success: false, error: "thinking unavailable" };
        }
        thinkingLevel = String(record["level"]);
        return base;
      case "new_session": {
        const cancelled = vetoNewSession;
        vetoNewSession = false;
        if (!cancelled) sessionFile = `/fake/new-${++sessionGeneration}.jsonl`;
        return { ...base, data: { cancelled } };
      }
      case "switch_session": {
        const cancelled = vetoSwitch;
        vetoSwitch = false;
        return { ...base, data: { cancelled } };
      }
      case "get_entries":
        return {
          ...base,
          data: entriesQueue.shift() ?? { entries: [], leafId: null, hasMore: false },
        };
      case "get_messages":
        return { ...base, data: messagesQueue.shift() ?? { messages: [] } };
      case "get_session_stats":
        return { ...base, data: statsQueue.shift() ?? {} };
      case "fork":
        return { ...base, data: { text: "Hello pi", cancelled: false } };
      case "clear_queue":
        return clearQueue === "unknown_command"
          ? { ...base, success: false, error: "Unknown command: clear_queue" }
          : { ...base, data: clearQueue };
      default:
        return base;
    }
  };

  const handleStdinChunk = Effect.fnUntraced(function* (chunk: Uint8Array) {
    stdinBuffer += new TextDecoder().decode(chunk);
    while (true) {
      const newline = stdinBuffer.indexOf("\n");
      if (newline === -1) return;
      const line = stdinBuffer.slice(0, newline);
      stdinBuffer = stdinBuffer.slice(newline + 1);
      if (line.length === 0) continue;
      const record = decodeJsonLine(line) as PiRpcRecord;
      if (record["type"] === "prompt") {
        promptThinkingLevels.push(thinkingLevel);
        promptModels.push(currentModel);
      }
      allRequests.push(record);
      yield* Queue.offer(requests, record);
      if (record["type"] === "get_state" && deferState) {
        deferState = false;
        deferredStateRequest = record;
        continue;
      }
      if (record["type"] === deferredLifecycle) {
        deferredLifecycle = undefined;
        continue;
      }
      const response = respondTo(record);
      if (response !== null) yield* emit(response);
    }
  });

  let lastSpawn: { readonly args: ReadonlyArray<string>; readonly env: NodeJS.ProcessEnv } = {
    args: [],
    env: {},
  };
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (ChildProcess.isStandardCommand(command)) {
        lastSpawn = {
          args: command.args,
          env: command.options.env ?? {},
        };
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(FAKE_PID),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach(handleStdinChunk),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );

  const takeRequest = (type: string): Effect.Effect<PiRpcRecord> =>
    Effect.gen(function* () {
      while (true) {
        const record = yield* Queue.take(requests);
        if (record["type"] === type) return record;
      }
    });

  return {
    spawner,
    failNextThinking: () => {
      failThinking = true;
    },
    promptThinkingLevels,
    promptModels,
    emit,
    takeRequest,
    queueEntries: (data) => entriesQueue.push(data),
    queueMessages: (data) => messagesQueue.push(data),
    deferNextState: () => {
      deferState = true;
    },
    resolveDeferredState: Effect.fnUntraced(function* (data: unknown) {
      const record = deferredStateRequest;
      assert.isDefined(record);
      deferredStateRequest = undefined;
      yield* emit({
        type: "response",
        id: record!["id"],
        command: "get_state",
        success: true,
        data,
      });
    }),
    failNextState: () => {
      failState = true;
    },
    failNextPrompt: () => {
      failPrompt = true;
    },
    deferNextLifecycle: (type) => {
      deferredLifecycle = type;
    },
    deferNextModelSelection: () => {
      deferredLifecycle = "set_model";
    },
    queueModels: (value) => {
      models = value;
    },
    vetoNextNewSession: () => {
      vetoNewSession = true;
    },
    allRequests: () => allRequests,
    vetoNextSwitch: () => {
      vetoSwitch = true;
    },
    queueState: (data) => stateQueue.push(data),
    setStreaming: (streaming) => {
      isStreaming = streaming;
    },
    setCompacting: (compacting) => {
      isCompacting = compacting;
    },
    queueStats: (data) => statsQueue.push(data),
    setClearQueue: (result) => {
      clearQueue = result;
    },
    closeStdout: Queue.end(stdout),
    lastSpawn: () => lastSpawn,
  } satisfies FakePi;
});
