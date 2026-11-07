import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerSettings from "../serverSettings.ts";
import * as CodexSurvivors from "../provider/CodexSurvivors.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { continueRestartedRun } from "./RestartContinuation.ts";

const threadId = ThreadId.make("thread:restart");
const runId = RunId.make("run:restart");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const providerThreadId = ProviderThreadId.make("provider-thread:restart");
const sessionId = ProviderSessionId.make("session:restart");
const attemptId = RunAttemptId.make("attempt:restart");
const now = DateTime.makeUnsafe("2026-10-03T12:00:00.000Z");

function makeProjection() {
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("restart-project"),
      providerInstanceId: instanceId,
      archivedAt: null,
      deletedAt: null,
      lineage: { parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
    },
    runs: [
      {
        id: runId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "gpt-6" },
        providerThreadId,
        activeAttemptId: attemptId,
        status: "running",
        requestedAt: now,
        completedAt: null,
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        appThreadId: threadId,
        ownerNodeId: null,
        driver,
        providerInstanceId: instanceId,
        providerSessionId: sessionId,
        nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
        status: "active",
      },
    ],
    providerSessions: [
      { id: sessionId, driver, providerInstanceId: instanceId, status: "running" },
    ],
    providerTurns: [
      {
        id: ProviderTurnId.make("turn:restart"),
        providerThreadId,
        runAttemptId: attemptId,
        status: "running",
      },
    ],
    runtimeRequests: [],
    attempts: [],
    nodes: [],
    subagents: [],
    messages: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
}

const cutMidTurn = (extra: Record<string, unknown> = {}) => {
  const base = makeProjection();
  return {
    ...base,
    runs: [
      {
        ...base.runs[0]!,
        status: "cancelled",
        completedAt: now,
        userMessageId: MessageId.make("message:user"),
        ...extra,
      },
    ],
    providerTurns: [{ ...base.providerTurns[0]!, status: "cancelled" }],
  } as unknown as OrchestrationV2ThreadProjection;
};

const survivorContinuation = (
  projection: OrchestrationV2ThreadProjection,
  enabled = true,
  sourceRunId = runId,
) =>
  Effect.gen(function* () {
    const commands: Array<
      Parameters<ThreadManagementService.ThreadManagementService["Service"]["dispatch"]>[0]
    > = [];
    const starts: RunId[] = [];
    const binding = {
      instanceId,
      threadId,
      sourceRunId: runId,
      recordName: "instance",
      nativeThreadId: "native-thread",
      nativeTurnId: "native-turn",
    };
    yield* continueRestartedRun({ threadId, sourceRunId }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(CodexSurvivors.CodexSurvivors)({ list: Effect.succeed([binding]) }),
          Layer.mock(ProviderTurnStart.ProviderTurnStartServiceV2)({
            start: ({ runId }) =>
              Effect.sync(() => {
                starts.push(runId);
              }),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(projection),
            recoverDelegatedTask: () => Effect.void,
            dispatch: (command) => {
              commands.push(command);
              return Effect.succeed({} as never);
            },
          }),
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: enabled }),
        ),
      ),
    );
    return { commands, starts };
  });

it.effect("a survivor continues even when automatic restart continuation is disabled", () =>
  Effect.gen(function* () {
    const result = yield* survivorContinuation(cutMidTurn(), false);
    assert.lengthOf(result.commands, 1);
  }),
);

it.effect("an existing survivor continuation reuses its run without another message", () =>
  Effect.gen(function* () {
    const source = cutMidTurn();
    const continuationId = RunId.make("existing-continuation");
    const continuation = {
      ...source.runs[0]!,
      id: continuationId,
      ordinal: 2,
      status: "starting" as const,
      restartContinuationOfRunId: runId,
    };
    const projection = {
      ...source,
      runs: [...source.runs, continuation],
      messages: [{ id: MessageId.make(`message:restart-continuation:${runId}`) }],
    } as unknown as OrchestrationV2ThreadProjection;
    const result = yield* survivorContinuation(projection);
    assert.deepEqual(result.commands, []);
    assert.deepEqual(result.starts, [continuationId]);
  }),
);

it.effect("a previously prepared continuation adopts in its existing run", () =>
  Effect.gen(function* () {
    const source = cutMidTurn({
      status: "starting",
      restartContinuationOfRunId: RunId.make("prior-run"),
    });
    const result = yield* survivorContinuation(source, false);
    assert.deepEqual(result.commands, []);
    assert.deepEqual(result.starts, [runId]);
  }),
);

it.effect("a newer unrelated run does not adopt the survivor", () =>
  Effect.gen(function* () {
    const source = cutMidTurn();
    const newer = {
      ...source.runs[0]!,
      id: RunId.make("unrelated"),
      ordinal: 2,
      status: "completed" as const,
    };
    const result = yield* survivorContinuation({ ...source, runs: [...source.runs, newer] });
    assert.deepEqual(result.commands, []);
    assert.deepEqual(result.starts, []);
    const later = {
      ...newer,
      providerInstanceId: ProviderInstanceId.make("other"),
      modelSelection: { instanceId: ProviderInstanceId.make("other"), model: "other" },
    };
    const unrelated = yield* survivorContinuation(
      { ...source, runs: [...source.runs, later] },
      true,
      later.id,
    );
    assert.deepEqual(unrelated.commands, []);
  }),
);

it.effect("the continuation chain limit does not prevent adopting a survivor", () =>
  Effect.gen(function* () {
    const source = cutMidTurn({ restartContinuationOfRunId: RunId.make("ancestor-1") });
    const ancestor1 = {
      ...source.runs[0]!,
      id: RunId.make("ancestor-1"),
      ordinal: 0,
      restartContinuationOfRunId: RunId.make("ancestor-2"),
    };
    const ancestor2 = {
      ...source.runs[0]!,
      id: RunId.make("ancestor-2"),
      ordinal: -1,
      restartContinuationOfRunId: RunId.make("ancestor-3"),
    };
    const ancestor3 = { ...source.runs[0]!, id: RunId.make("ancestor-3"), ordinal: -2 };
    const result = yield* survivorContinuation({
      ...source,
      runs: [...source.runs, ancestor1, ancestor2, ancestor3],
    });
    assert.lengthOf(result.commands, 1);
  }),
);

it.effect("a committed source Stop prevents survivor continuation", () =>
  Effect.gen(function* () {
    const source = cutMidTurn();
    const projection = {
      ...source,
      runs: [
        ...source.runs,
        {
          ...source.runs[0]!,
          id: RunId.make("existing-continuation"),
          ordinal: 2,
          status: "starting",
          restartContinuationOfRunId: runId,
        },
      ],
      messages: [{ id: MessageId.make(`message:restart-continuation:${runId}`) }],
      turnItems: [{ type: "run_interrupt_request", runId }],
    } as unknown as OrchestrationV2ThreadProjection;
    const result = yield* survivorContinuation(projection, false);
    assert.deepEqual(result.commands, []);
    assert.deepEqual(result.starts, []);
  }),
);
