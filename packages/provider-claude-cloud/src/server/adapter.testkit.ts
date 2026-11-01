import { expect } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Adapter from "@goat/provider-core/server/ProviderAdapter";
import { makeClaudeCloudAdapter } from "./adapter.ts";
import * as Cli from "./cli.ts";
import { ClaudeCloudError } from "./protocol.ts";
import type { SessionRead } from "./sessionRead.ts";
import { cloudAssistant, cloudPrompt, LOGIN, teleportTranscript } from "./testing.ts";

/** A read of a session that answered `prompt` with `reply` one second after the run started. */
export const sessionAnswer = (prompt: string, reply: string, costUsd: number | null = 0.0064) =>
  Effect.succeed({
    transcript: teleportTranscript([
      cloudPrompt(prompt, "1970-01-01T00:00:01.000Z"),
      cloudAssistant({ type: "text", text: reply }, "end_turn"),
    ]),
    costUsd,
  });
const sessionStillWorking = teleportTranscript([
  cloudPrompt("task", "1970-01-01T00:00:01.000Z"),
  cloudAssistant({ type: "tool_use", id: "tool-1" }, "tool_use"),
]);
/** A read of a session still working on the run's prompt. */
export const sessionWorkingRead = Effect.succeed({
  transcript: sessionStillWorking,
  costUsd: 0.0064,
});

/** The Claude Cloud adapter over fake CLI, PR and ledger seams, shared by the adapter tests. */
const INSTANCE = ProviderInstanceId.make("claude-cloud-test");
const THREAD = ThreadId.make("cloud-thread-test");
export const policy = {
  runtimeMode: "approval-required" as const,
  interactionMode: "default" as const,
  cwd: "/fixture/repo",
};
export const selection = { instanceId: INSTANCE, model: "cloud-default" };
export const source = {
  repository: "https://github.com/fixture/repository",
  branch: "main",
  sha: "a".repeat(40),
};

const makeTurn = Effect.fnUntraced(function* (
  providerThread: OrchestrationV2ProviderThread,
  ordinal = 1,
): Effect.fn.Return<Adapter.ProviderAdapterV2TurnInput> {
  const now = yield* DateTime.now;
  const appThread: OrchestrationV2AppThread = {
    id: THREAD,
    projectId: ProjectId.make("project-cloud"),
    title: "Cloud test",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: INSTANCE,
    modelSelection: selection,
    runtimeMode: policy.runtimeMode,
    interactionMode: policy.interactionMode,
    branch: "main",
    worktreePath: "/fixture/thread-worktree",
    activeProviderThreadId: providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  return {
    appThread,
    threadId: THREAD,
    runId: RunId.make(`cloud-run-${ordinal}`),
    runOrdinal: ordinal,
    providerTurnOrdinal: ordinal,
    attemptId: RunAttemptId.make(`cloud-attempt-${ordinal}`),
    rootNodeId: NodeId.make(`cloud-root-${ordinal}`),
    providerThread,
    message: {
      messageId: MessageId.make(`cloud-message-${ordinal}`),
      text: "task",
      attachments: [],
      createdBy: "user" as const,
      creationSource: "web" as const,
    },
    modelSelection: selection,
    runtimePolicy: policy,
    cloudSource: source,
    cloudLaunchSource: { cwd: "/fixture/project", restriction: "project-folder" },
  } satisfies Adapter.ProviderAdapterV2TurnInput;
});

export const makeHarness = Effect.fnUntraced(function* () {
  let starts = 0;
  let sends = 0;
  let reads = 0;
  // Scripted session reads in order. Once they run out, a read fails unless the session is
  // marked as working, so PR-only tests keep today's PR completion.
  let sessionReplies: Array<Effect.Effect<SessionRead, ClaudeCloudError>> = [];
  let sessionWorking = false;
  // What the saved thread says about the run: its message and whether it is the first run.
  let history: {
    prompt: string | undefined;
    first: boolean;
  } = { prompt: "task", first: false };
  let historyUnreadable = false;
  const sessionReadTimes: number[] = [];
  let startError: ClaudeCloudError | undefined;
  let observedSummary = "Changed behavior.";
  let sendError: ClaudeCloudError | undefined;
  let controlError: ClaudeCloudError | undefined;
  let observationError: ClaudeCloudError | undefined;
  let resolvedLogin = LOGIN;
  const startCwds: string[] = [];
  const controlCommands: Array<{ kind: string; cwd: string; id?: string }> = [];
  let failCommitAt = -1;
  let commitCalls = 0;
  const ledger: NonNullable<OrchestrationV2ProviderThread["cloudTask"]>[] = [];
  const accepted = yield* Deferred.make<void>();
  const admitted = yield* Deferred.make<void>();
  const prRecorded = yield* Deferred.make<void>();
  // Completes when an observation reads its deadline, just before it starts waiting.
  const following = yield* Deferred.make<void>();
  const exit = yield* Deferred.make<void, ClaudeCloudError>();
  const read = yield* Deferred.make<void>();
  const deliver = yield* Deferred.make<void>();
  const sendReached = yield* Deferred.make<void>();
  const sendRelease = yield* Deferred.make<void>();
  const startedAt = yield* DateTime.now;
  let pauseSend = false;
  let found = true;
  // Trust prompts Claude shows during start; the CLI answers them only with a trust policy.
  let trustPrompts = 0;
  let trustAllowed = true;
  const trustChecks: string[] = [];
  const trustRecords: Array<{ cwd: string; threadId: string; prompts: number }> = [];
  const cli = Cli.ClaudeCloudCli.of({
    readiness: (login, cwd) =>
      Effect.sync(() => {
        expect(login).toEqual(LOGIN);
        expect(cwd).toBe("/fixture/goat/control");
        controlCommands.push({ kind: "readiness", cwd });
        return { version: "2.1.296" };
      }),
    start: (_login, cwd, _prompt, trust) =>
      Effect.gen(function* () {
        startCwds.push(cwd);
        expect(ledger.at(-1)?.status).toBe("submitting");
        starts += 1;
        if (trustPrompts > 0 && !trust)
          return yield* new ClaudeCloudError({
            detail: "Claude Code hasn't trusted this folder yet.",
            outcome: "rejected",
          });
        for (let prompt = 0; prompt < trustPrompts; prompt++) trust?.onAccepted();
        if (startError) return yield* startError;
        return {
          receipt: {
            taskId: "session_ABC123",
            url: "https://claude.ai/code/session_ABC123",
            title: "Task",
          },
          exited: Deferred.await(exit),
        };
      }),
    acceptTrust: () => Effect.die("acceptTrust is driven by the CLI tests"),
    readSession: (login, root, id) =>
      Effect.gen(function* () {
        expect(login).toEqual(LOGIN);
        expect(root).toBe("/fixture/goat/reads");
        expect(id).toBe("session_ABC123");
        sessionReadTimes.push(
          DateTime.toEpochMillis(yield* DateTime.now) - DateTime.toEpochMillis(startedAt),
        );
        const next = sessionReplies.shift();
        if (next) return yield* next;
        return sessionWorking
          ? { transcript: sessionStillWorking, costUsd: 0.0064 }
          : yield* new ClaudeCloudError({
              detail: "Fixture session is unreadable.",
              outcome: "uncertain",
            });
      }),
    send: (login, cwd, id) =>
      Effect.gen(function* () {
        expect(login).toEqual(LOGIN);
        expect(cwd).toBe("/fixture/goat/control");
        controlCommands.push({ kind: "send", cwd, id });
        expect(ledger.at(-1)?.status).toBe("submitting");
        expect(ledger.at(-1)?.progress).toBe("Submitting follow-up");
        sends += 1;
        yield* Deferred.succeed(sendReached, undefined);
        if (pauseSend) yield* Deferred.await(sendRelease);
        if (sendError) return yield* sendError;
        return { taskId: id, url: `https://claude.ai/code/${id}` };
      }),
  });
  const adapter = yield* makeClaudeCloudAdapter({
    instanceId: INSTANCE,
    resolveLogin: Effect.sync(() => resolvedLogin),
    resolveControlCwd: Effect.suspend(() =>
      controlError ? Effect.fail(controlError) : Effect.succeed("/fixture/goat/control"),
    ),
    runStartedAt: () => Deferred.succeed(following, undefined).pipe(Effect.as(startedAt)),
    runHistory: () =>
      historyUnreadable
        ? Effect.fail(
            new ClaudeCloudError({ detail: "Fixture history lost.", outcome: "uncertain" }),
          )
        : Effect.sync(() => history),
    resolveReadRoot: Effect.succeed("/fixture/goat/reads"),
    observe: (input) =>
      Effect.gen(function* () {
        expect(input.repository).toBe(source.repository);
        expect(input.sessionUrl).toBe("https://claude.ai/code/session_ABC123");
        reads += 1;
        yield* Deferred.succeed(read, undefined);
        if (observationError) return yield* observationError;
        if (found) yield* Deferred.await(deliver);
        return found
          ? {
              prUrl: "https://github.com/fixture/repository/pull/1",
              branch: "claude/result",
              summary: observedSummary,
            }
          : null;
      }),
    folderTrust: {
      allowed: (cwd) =>
        Effect.sync(() => {
          trustChecks.push(cwd);
          return trustAllowed;
        }),
      record: (input) =>
        Effect.sync(() => {
          trustRecords.push(input);
        }),
    },
  }).pipe(Effect.provideService(Cli.ClaudeCloudCli, cli));
  const runtime = yield* adapter.openSession({
    threadId: THREAD,
    providerSessionId: ProviderSessionId.make("cloud-session-test"),
    modelSelection: selection,
    runtimePolicy: policy,
  });
  const providerThread = yield* runtime.ensureThread({
    threadId: THREAD,
    modelSelection: selection,
    runtimePolicy: policy,
  });
  const commitCloudTask: NonNullable<Adapter.ProviderAdapterV2TurnInput["commitCloudTask"]> = (
    task,
  ) =>
    Effect.gen(function* () {
      commitCalls += 1;
      if (commitCalls === failCommitAt)
        return yield* new Adapter.ProviderAdapterProtocolError({
          driver: adapter.driver,
          detail: "fixture commit loss",
        });
      ledger.push(task);
      if (task.status === "running" && task.progress === "Running in the cloud")
        yield* Deferred.succeed(accepted, undefined);
      if (task.progress === "Follow-up accepted") yield* Deferred.succeed(admitted, undefined);
      if (task.status === "running" && task.prUrl) yield* Deferred.succeed(prRecorded, undefined);
    });
  const input = { ...(yield* makeTurn(providerThread)), commitCloudTask };
  if (!runtime.subscribeEvents) return yield* Effect.die("The adapter must expose its events.");
  const subscription = yield* runtime.subscribeEvents;
  const events: Adapter.ProviderAdapterV2Event[] = [];
  const terminal = yield* Deferred.make<void>();
  // The second terminal, for tests that run two turns on one session.
  const secondTerminal = yield* Deferred.make<void>();
  yield* subscription.events.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        events.push(event);
        if (event.type === "turn.terminal")
          yield* (yield* Deferred.isDone(terminal))
            ? Deferred.succeed(secondTerminal, undefined)
            : Deferred.succeed(terminal, undefined);
      }),
    ),
    Effect.forkChild,
  );
  const task = {
    taskId: "session_ABC123",
    url: "https://claude.ai/code/session_ABC123",
    status: "running" as const,
    tracking: "polled" as const,
    source,
    localChangesExcluded: false,
    progress: "Running in the cloud",
    updatedAt: DateTime.formatIso(startedAt),
  };
  const saved = {
    ...providerThread,
    nativeThreadRef: {
      driver: adapter.driver,
      nativeId: task.taskId,
      strength: "strong" as const,
      fingerprint: LOGIN.binding,
    },
    cloudTask: task,
  };
  const { message: _message, cloudLaunchSource: _launch, ...attach } = input;
  return {
    runtime,
    input,
    saved,
    attach: { ...attach, providerThread: saved, cloudTask: task },
    ledger,
    events,
    accepted,
    admitted,
    prRecorded,
    /**
     * Lets the session-linked PR be found while the session stays unreadable, then runs the clock
     * past the three failed reads after which the PR stands as the result.
     */
    pullRequestStands: Deferred.succeed(deliver, undefined).pipe(
      Effect.andThen(Deferred.await(prRecorded)),
      Effect.andThen(TestClock.adjust("3 minutes")),
    ),
    following,
    exit,
    read,
    deliver,
    sendReached,
    sendRelease,
    terminal,
    secondTerminal,
    counts: () => ({ starts, sends, reads }),
    noMatch: () => {
      found = false;
    },
    match: () => {
      found = true;
    },
    failCommit: (number: number) => {
      failCommitAt = number;
    },
    pauseSend: () => {
      pauseSend = true;
    },
    controlCommands,
    startCwds,
    controlError: (error: ClaudeCloudError) => {
      controlError = error;
    },
    summary: (summary: string) => {
      observedSummary = summary;
    },
    startError: (error: ClaudeCloudError) => {
      startError = error;
    },
    observationError: (error: ClaudeCloudError) => {
      observationError = error;
    },
    login: (login: typeof LOGIN) => {
      resolvedLogin = login;
    },
    sendError: (error: ClaudeCloudError) => {
      sendError = error;
    },
    trustPrompts: (count: number) => {
      trustPrompts = count;
    },
    disallowTrust: () => {
      trustAllowed = false;
    },
    trustChecks,
    trustRecords,
    sessionReads: (...replies: Array<Effect.Effect<SessionRead, ClaudeCloudError>>) => {
      sessionReplies = replies;
    },
    sessionReadTimes,
    sessionWorking: () => {
      sessionWorking = true;
    },
    history: (next: Partial<typeof history>) => {
      history = { ...history, ...next };
    },
    historyUnreadable: () => {
      historyUnreadable = true;
    },
  };
});
