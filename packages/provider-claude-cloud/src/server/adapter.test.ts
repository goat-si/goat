import { expect, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  ProviderTurnId,
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
import { LOGIN } from "./testing.ts";

const INSTANCE = ProviderInstanceId.make("claude-cloud-test");
const THREAD = ThreadId.make("cloud-thread-test");
const policy = {
  runtimeMode: "approval-required" as const,
  interactionMode: "default" as const,
  cwd: "/fixture/repo",
};
const selection = { instanceId: INSTANCE, model: "cloud-default" };
const source = {
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

const makeHarness = Effect.fnUntraced(function* () {
  let starts = 0;
  let sends = 0;
  let reads = 0;
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
    runStartedAt: () => Effect.succeed(startedAt),
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
    });
  const input = { ...(yield* makeTurn(providerThread)), commitCloudTask };
  const subscription = yield* runtime.subscribeEvents!;
  const events: Adapter.ProviderAdapterV2Event[] = [];
  const terminal = yield* Deferred.make<void>();
  yield* subscription.events.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        events.push(event);
        if (event.type === "turn.terminal") yield* Deferred.succeed(terminal, undefined);
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
    exit,
    read,
    deliver,
    sendReached,
    sendRelease,
    terminal,
    counts: () => ({ starts, sends, reads }),
    noMatch: () => {
      found = false;
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
  };
});

it.effect.each([1, 2])(
  "a registered folder's trust prompts (%s) are accepted, noticed in the thread and recorded",
  (prompts) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        h.trustPrompts(prompts);
        yield* h.runtime.startTurn(h.input);
        yield* Deferred.await(h.accepted);
        expect(h.trustChecks).toEqual(["/fixture/project"]);
        expect(h.trustRecords).toEqual([
          { cwd: "/fixture/project", threadId: h.input.threadId, prompts },
        ]);
        const notices = h.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "system_notice"
            ? [event.turnItem.message]
            : [],
        );
        expect(notices).toEqual([
          "Claude Code asked to trust /fixture/project. GOAT accepted it automatically.",
        ]);
        expect(h.ledger.at(-1)?.status).toBe("running");
      }),
    ),
);

it.effect("a folder outside GOAT's projects keeps the trust rejection and records nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.trustPrompts(1);
      h.disallowTrust();
      yield* h.runtime.startTurn(h.input);
      yield* Deferred.await(h.terminal);
      expect(h.trustRecords).toEqual([]);
      expect(h.ledger.at(-1)).toMatchObject({
        status: "failed",
        error: "Claude Code hasn't trusted this folder yet.",
      });
    }),
  ),
);

it.effect(
  "acceptance stays open until a linked PR is durably committed; the base owns result messages",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.runtime.startTurn(h.input);
        yield* Deferred.await(h.accepted);
        expect(h.ledger.at(-1)?.tracking).toBe("polled");
        expect(h.events.some((event) => event.type === "turn.terminal")).toBe(false);
        yield* Deferred.succeed(h.exit, undefined);
        yield* Deferred.await(h.read);
        expect(h.events.some((event) => event.type === "turn.terminal")).toBe(false);
        yield* Deferred.succeed(h.deliver, undefined);
        yield* Deferred.await(h.terminal);
        expect(h.ledger.at(-1)?.status).toBe("succeeded");
        expect(h.ledger.at(-1)?.summary).toContain("Result PR found\nChanged behavior.");
        expect(h.events.filter((event) => event.type === "message.updated")).toEqual([]);
        const result = h.events.findIndex(
          (event) =>
            event.type === "provider_thread.updated" &&
            event.providerThread.cloudTask?.status === "succeeded",
        );
        expect(result).toBeLessThan(h.events.findIndex((event) => event.type === "turn.terminal"));
        expect((yield* h.runtime.readThreadSnapshot({ providerThread: h.saved })).messages).toEqual(
          [],
        );
        yield* h.runtime.startTurn(h.input);
        expect(h.counts()).toEqual({ starts: 1, sends: 0, reads: 1 });
      }),
    ),
);
it.effect(
  "restart observes the saved ID without another launch and keeps the original deadline",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        h.noMatch();
        yield* TestClock.adjust("119 minutes");
        yield* h.runtime.resumeTurn!(h.attach);
        yield* Deferred.await(h.read);
        yield* TestClock.adjust("1 minute");
        yield* Deferred.await(h.terminal);
        expect(h.ledger.at(-1)?.status).toBe("unknown");
        expect(h.ledger.at(-1)?.url).toBe(h.saved.cloudTask.url);
        expect(h.counts().starts + h.counts().sends).toBe(0);
      }),
    ),
);
it.effect.each(["submitting", "unknown", "failed"] as const)(
  "attach reconciles %s without replay and duplicate attachment has one terminal",
  (status) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const attach = {
          ...h.attach,
          cloudTask: { ...h.saved.cloudTask, status, progress: "Submitting follow-up" },
        };
        yield* h.runtime.resumeTurn!(attach);
        yield* Deferred.await(h.terminal);
        yield* h.runtime.resumeTurn!(attach);
        expect(h.events.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
        expect(h.counts()).toEqual({ starts: 0, sends: 0, reads: 0 });
        expect(h.ledger.at(-1)?.status).toBe("unknown");
      }),
    ),
);
it.effect(
  "committed PR result before crash completes the deterministic result without another lookup",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.runtime.resumeTurn!({
          ...h.attach,
          cloudTask: {
            ...h.saved.cloudTask,
            status: "succeeded",
            prUrl: "https://github.com/fixture/repository/pull/1",
            branch: "claude/result",
            summary: "Delivered.",
          },
        });
        yield* Deferred.await(h.terminal);
        expect(h.events.filter((event) => event.type === "message.updated")).toEqual([]);
        expect(h.events.find((event) => event.type === "turn.terminal")?.status).toBe("completed");
        expect(h.counts()).toEqual({ starts: 0, sends: 0, reads: 0 });
      }),
    ),
);
it.effect(
  "follow-up records intent and ack, preserves original source and does not call a prior PR completion",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const accepted = {
          ...h.saved,
          cloudTask: {
            ...h.saved.cloudTask,
            status: "submitting" as const,
            prUrl: "https://github.com/fixture/repository/pull/1",
            branch: "claude/old",
            summary: "Previous result",
          },
        };
        yield* h.runtime.startTurn({
          ...h.input,
          providerThread: accepted,
          runtimePolicy: { ...policy, cwd: "/missing/deleted-project" },
          cloudSource: {
            repository: "https://github.com/fixture/other",
            branch: "dirty",
            sha: "b".repeat(40),
          },
        });
        yield* Deferred.await(h.terminal);
        expect(h.ledger[0]?.progress).toBe("Submitting follow-up");
        expect(h.ledger.at(-1)?.progress).toBe("Follow-up accepted");
        expect(h.ledger.at(-1)?.source).toEqual(source);
        expect(h.ledger.at(-1)?.prUrl).toBeUndefined();
        expect(h.ledger.at(-1)?.taskId).toBe(accepted.nativeThreadRef.nativeId);
        expect(h.controlCommands).toEqual([
          { kind: "readiness", cwd: "/fixture/goat/control" },
          { kind: "send", cwd: "/fixture/goat/control", id: accepted.nativeThreadRef.nativeId },
        ]);
        const updated = h.events.findLast((event) => event.type === "provider_thread.updated");
        expect(updated?.providerThread.nativeThreadRef).toEqual(accepted.nativeThreadRef);
        expect(h.ledger.at(-1)?.summary).toContain("not completed work");
        expect(h.events.filter((event) => event.type === "message.updated")).toEqual([]);
        expect(h.counts()).toEqual({ starts: 0, sends: 1, reads: 0 });
      }),
    ),
);
it.effect.each([1, 2])("follow-up commit failure %s never establishes delivery success", (index) =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.failCommit(index);
      yield* h.runtime.startTurn({ ...h.input, providerThread: h.saved });
      yield* Deferred.await(h.terminal);
      expect(h.counts().sends).toBe(index === 1 ? 0 : 1);
      expect(h.events.find((event) => event.type === "turn.terminal")?.status).toBe("failed");
      expect(h.ledger.at(-1)?.status).toBe("unknown");
      expect(
        h.events.find((event) => event.type === "provider_session.updated")?.providerSession
          .capabilities.sessions.followUp?.supported,
      ).toBe(false);
    }),
  ),
);
it.effect("crash during send leaves durable submitting and recovery never resends", () =>
  Effect.gen(function* () {
    let durable: OrchestrationV2ProviderThread["cloudTask"];
    yield* Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        h.pauseSend();
        yield* h.runtime.startTurn({ ...h.input, providerThread: h.saved });
        yield* Deferred.await(h.sendReached);
        durable = h.ledger.at(-1);
        expect(durable?.status).toBe("submitting");
      }),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const restored = yield* makeHarness();
        yield* restored.runtime.resumeTurn!({ ...restored.attach, cloudTask: durable! });
        yield* Deferred.await(restored.terminal);
        expect(restored.counts().sends).toBe(0);
        expect(restored.ledger.at(-1)?.status).toBe("unknown");
      }),
    );
  }),
);
it.effect.each(["rejected", "uncertain"] as const)(
  "follow-up %s keeps session identity and persists the correct delivery milestone",
  (outcome) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        h.sendError(new ClaudeCloudError({ detail: "Delivery diagnostic", outcome }));
        yield* h.runtime.startTurn({ ...h.input, providerThread: h.saved });
        yield* Deferred.await(h.terminal);
        expect(h.ledger.at(-1)?.status).toBe(outcome === "rejected" ? "running" : "unknown");
        expect(h.ledger.at(-1)?.taskId).toBe(h.saved.cloudTask.taskId);
        expect(h.ledger.at(-1)?.source).toEqual(source);
        expect(h.events.find((event) => event.type === "turn.terminal")?.status).toBe("failed");
      }),
    ),
);
it.effect("restart after follow-up ack settles only admission without PR observation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.runtime.resumeTurn!({
        ...h.attach,
        cloudTask: { ...h.saved.cloudTask, progress: "Follow-up accepted" },
      });
      yield* Deferred.await(h.terminal);
      expect(h.counts().reads).toBe(0);
      expect(h.ledger.at(-1)?.summary).toContain("not completed work");
      expect(h.events.filter((event) => event.type === "message.updated")).toEqual([]);
    }),
  ),
);
it.effect("unsupported cancel leaves remote identity intact and invokes zero commands", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const error = yield* h.runtime
        .interruptTurn({
          providerThread: h.saved,
          providerTurnId: ProviderTurnId.make("cancel-test"),
        })
        .pipe(Effect.flip);
      expect(error.message).toContain("no supported CLI cancellation");
      expect(h.counts()).toEqual({ starts: 0, sends: 0, reads: 0 });
    }),
  ),
);
it.effect(
  "observer scope shutdown detaches without changing task to cancelled or sending commands",
  () =>
    Effect.gen(function* () {
      let seen: NonNullable<OrchestrationV2ProviderThread["cloudTask"]>[] = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness();
          yield* h.runtime.resumeTurn!(h.attach);
          yield* Deferred.await(h.read);
          seen = h.ledger;
          expect(h.counts().sends).toBe(0);
        }),
      );
      expect(seen.some((task) => task.status === "cancelled")).toBe(false);
    }),
);

it.effect(
  "control directory rejection preserves the accepted session without another launch or send",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        h.controlError(
          new ClaudeCloudError({ detail: "Control cwd unavailable", outcome: "rejected" }),
        );
        yield* h.runtime.startTurn({
          ...h.input,
          providerThread: h.saved,
          runtimePolicy: { ...policy, cwd: "/missing/deleted-project" },
        });
        yield* Deferred.await(h.terminal);
        expect(h.controlCommands).toEqual([]);
        expect(h.counts()).toEqual({ starts: 0, sends: 0, reads: 0 });
        expect(h.ledger.at(-1)?.status).toBe("running");
        expect(h.ledger.at(-1)?.taskId).toBe(h.saved.nativeThreadRef.nativeId);
        expect(h.ledger.at(-1)?.source).toEqual(source);
        expect(
          h.events.some(
            (event) =>
              event.type === "provider_session.updated" &&
              event.providerSession.capabilities.sessions.followUp?.supported === false,
          ),
        ).toBe(false);
      }),
    ),
);

it.effect("publishes the explicit source restriction and no local runtime capabilities", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      expect(h.runtime.providerSession.capabilities.sessions.sourceRestriction).toBe(
        "project-folder",
      );
      expect(h.runtime.providerSession.capabilities.turns.terminalStatusQuality).toBe("none");
      expect(h.runtime.providerSession.capabilities.tools.supportsMcpTools).toBe(false);
    }),
  ),
);
it.effect.each(["submitting", "unknown", "failed"] as const)(
  "blocks saved %s follow-ups even after base marks the current run submitting",
  (status) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const prior = { ...h.saved, cloudTask: { ...h.saved.cloudTask, status } };
        yield* h.runtime.resumeThread({ providerThread: prior });
        yield* h.runtime.startTurn({
          ...h.input,
          providerThread: { ...prior, cloudTask: { ...prior.cloudTask, status: "submitting" } },
        });
        yield* Deferred.await(h.terminal);
        expect(h.counts()).toEqual({ starts: 0, sends: 0, reads: 0 });
        expect(h.controlCommands).toEqual([]);
        expect(h.ledger.at(-1)?.status).toBe("unknown");
      }),
    ),
);
it.effect("does not clear uncertainty on an otherwise unsupported follow-up", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.runtime.startTurn({
        ...h.input,
        providerThread: { ...h.saved, cloudTask: { ...h.saved.cloudTask, status: "unknown" } },
        modelSelection: { ...selection, model: "local-model" },
      });
      yield* Deferred.await(h.terminal);
      expect(h.ledger.at(-1)?.status).toBe("unknown");
      expect(h.controlCommands).toEqual([]);
    }),
  ),
);
it.effect.each([
  { modelSelection: { ...selection, model: "local-model" } },
  { modelSelection: { ...selection, options: [{ id: "effort", value: "high" }] } },
  { runtimePolicy: { ...policy, interactionMode: "plan" as const } },
  { runtimePolicy: { ...policy, runtimeMode: "full-access" as const } },
  { runtimePolicy: { ...policy, reasoningEffort: "high" } },
])("rejects unsupported local controls before any remote command (%j)", (patch) =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.runtime.startTurn({ ...h.input, ...patch, providerThread: h.saved });
      yield* Deferred.await(h.terminal);
      expect(h.controlCommands).toEqual([]);
      expect(h.counts()).toEqual({ starts: 0, sends: 0, reads: 0 });
      expect(h.ledger.at(-1)?.summary).toContain("Follow-up rejected");
    }),
  ),
);
it.effect("changed sibling binding rejects without sending or rebinding the saved session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.login({ ...LOGIN, binding: "another-login" });
      yield* h.runtime.startTurn({ ...h.input, providerThread: h.saved });
      yield* Deferred.await(h.terminal);
      expect(h.controlCommands).toEqual([]);
      expect(h.ledger.at(-1)?.taskId).toBe(h.saved.cloudTask.taskId);
      expect(h.ledger.at(-1)?.status).toBe("running");
    }),
  ),
);
it.effect("trust refusal has no accepted create and preserves an actionable error summary", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.startError(
        new ClaudeCloudError({
          outcome: "rejected",
          detail:
            "Claude Code hasn't trusted this folder yet. Open it once with `claude` in /fixture/project, accept the trust prompt, then try again.",
        }),
      );
      yield* h.runtime.startTurn(h.input);
      yield* Deferred.await(h.terminal);
      expect(h.counts().starts).toBe(1);
      expect(h.ledger.at(-1)?.status).toBe("failed");
      expect(h.ledger.at(-1)?.summary).toContain("Open it once with `claude` in /fixture/project");
      expect(h.ledger.at(-1)?.taskId).toBe(h.input.runId);
    }),
  ),
);
it.effect(
  "post-acceptance sender failure retains identity and blocks follow-up without observing",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.runtime.startTurn(h.input);
        yield* Deferred.await(h.accepted);
        yield* Deferred.fail(
          h.exit,
          new ClaudeCloudError({ detail: "Sender exit uncertain", outcome: "uncertain" }),
        );
        yield* Deferred.await(h.terminal);
        expect(h.ledger.at(-1)?.taskId).toBe(h.saved.cloudTask.taskId);
        expect(h.ledger.at(-1)?.status).toBe("unknown");
        expect(h.ledger.at(-1)?.summary).toBe("Sender exit uncertain");
        expect(h.counts().reads).toBe(0);
      }),
    ),
);
it.effect("incomplete GitHub reads use the original deadline and retain a curated reason", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.observationError(
        new ClaudeCloudError({ outcome: "uncertain", detail: "fixture raw GitHub defect" }),
      );
      yield* TestClock.adjust("119 minutes");
      yield* h.runtime.resumeTurn!(h.attach);
      yield* Deferred.await(h.read);
      yield* TestClock.adjust("1 minute");
      yield* Deferred.await(h.terminal);
      expect(h.ledger.at(-1)?.status).toBe("unknown");
      expect(h.ledger.at(-1)?.summary).toContain("GitHub observation was incomplete");
      expect(h.ledger.at(-1)?.summary).not.toContain("fixture raw");
    }),
  ),
);
it.effect("recovered rejection settles only its saved receipt and emits one terminal", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const attach = {
        ...h.attach,
        cloudTask: {
          ...h.saved.cloudTask,
          progress: "Follow-up rejected",
          error: "Session archived",
        },
      };
      yield* h.runtime.resumeTurn!(attach);
      yield* Deferred.await(h.terminal);
      yield* h.runtime.resumeTurn!(attach);
      expect(h.ledger.at(-1)?.summary).toContain("Follow-up rejected: Session archived");
      expect(h.counts()).toEqual({ starts: 0, sends: 0, reads: 0 });
      expect(h.events.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
    }),
  ),
);
it.effect("saved malformed identity cannot perform observation or follow-up", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.runtime.resumeTurn!({
        ...h.attach,
        cloudTask: { ...h.saved.cloudTask, url: "https://claude.ai.evil.test/code/session_ABC123" },
      });
      yield* Deferred.await(h.terminal);
      expect(h.ledger.at(-1)?.status).toBe("unknown");
      expect(h.counts()).toEqual({ starts: 0, sends: 0, reads: 0 });
    }),
  ),
);

it.effect(
  "bounds final result summary while retaining the PR Summary prefix and truth caveat",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        h.summary("Summary start. " + "x".repeat(4000));
        yield* h.runtime.startTurn(h.input);
        yield* Deferred.await(h.accepted);
        yield* Deferred.succeed(h.exit, undefined);
        yield* Deferred.await(h.read);
        yield* Deferred.succeed(h.deliver, undefined);
        yield* Deferred.await(h.terminal);
        const summary = h.ledger.at(-1)?.summary;
        expect(summary?.length).toBeLessThanOrEqual(4000);
        expect(summary).toMatch(/^Result PR found\nSummary start\. /);
        expect(summary).toMatch(
          /PR presence does not confirm that the session stopped or its checks passed\.$/,
        );
      }),
    ),
);
it.effect("initial intent failure invokes no sender", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.failCommit(1);
      yield* h.runtime.startTurn(h.input);
      yield* Deferred.await(h.terminal);
      expect(h.counts()).toEqual({ starts: 0, sends: 0, reads: 0 });
      expect(h.ledger.at(-1)?.status).toBe("unknown");
    }),
  ),
);
it.effect(
  "failed initial acceptance acknowledgement retains the known ID and performs no PR reads",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        h.failCommit(2);
        yield* h.runtime.startTurn(h.input);
        yield* Deferred.await(h.terminal);
        expect(h.ledger.at(-1)?.status).toBe("unknown");
        expect(h.ledger.at(-1)?.taskId).toBe("session_ABC123");
        expect(h.ledger.at(-1)?.url).toBe("https://claude.ai/code/session_ABC123");
        expect(h.counts().starts).toBe(1);
        expect(h.counts().reads).toBe(0);
      }),
    ),
);

it.effect("rejects attachments before readiness or submission", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.runtime.startTurn({
        ...h.input,
        providerThread: h.saved,
        message: {
          ...h.input.message,
          attachments: [
            {
              type: "file",
              id: ChatAttachmentId.make("fixture-file"),
              name: "fixture.txt",
              mimeType: "text/plain",
              sizeBytes: 1,
            },
          ],
        },
      });
      yield* Deferred.await(h.terminal);
      expect(h.controlCommands).toEqual([]);
      expect(h.counts()).toEqual({ starts: 0, sends: 0, reads: 0 });
    }),
  ),
);

it.effect.each(
  [true, false, undefined].flatMap((included) =>
    ["result", "rejected", "uncertain"].map((outcome) => ({ included, outcome })),
  ),
)(
  "launches the project folder without a pushed SHA and preserves source evidence (%s)",
  ({ included, outcome }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const input = {
          ...h.input,
          cloudSource: { repository: source.repository, branch: "unpublished-local" },
          providerThread: {
            ...h.input.providerThread,
            cloudTask: {
              ...h.saved.cloudTask,
              taskId: h.input.runId,
              status: "submitting" as const,
              localChangesExcluded: true,
              ...(included === undefined ? {} : { localChangesIncluded: included }),
            },
          },
        };
        if (outcome !== "result")
          h.startError(
            new ClaudeCloudError({
              outcome: outcome === "rejected" ? "rejected" : "uncertain",
              detail: "Fixture sender refusal or uncertain admission",
            }),
          );
        yield* h.runtime.startTurn(input);
        if (outcome === "result") {
          yield* Deferred.await(h.accepted);
          yield* Deferred.succeed(h.exit, undefined);
          yield* Deferred.await(h.read);
          yield* Deferred.succeed(h.deliver, undefined);
        }
        yield* Deferred.await(h.terminal);
        expect(h.startCwds).toEqual(["/fixture/project"]);
        expect(h.controlCommands[0]?.cwd).toBe("/fixture/goat/control");
        expect(h.input.runtimePolicy.cwd).toBe("/fixture/repo");
        expect(h.input.appThread.worktreePath).toBe("/fixture/thread-worktree");
        expect(h.ledger[0]?.status).toBe("submitting");
        expect(h.ledger.at(-1)?.status).toBe(
          outcome === "result" ? "succeeded" : outcome === "rejected" ? "failed" : "unknown",
        );
        for (const task of h.ledger) {
          expect(task.localChangesIncluded).toBe(included);
          expect(Object.hasOwn(task, "localChangesIncluded")).toBe(included !== undefined);
          expect(task.localChangesExcluded).toBe(false);
          expect(task.source).toEqual(input.cloudSource);
        }
      }),
    ),
);

it.effect.each([
  { label: "missing launch source", launch: undefined, source },
  {
    label: "wrong restriction",
    launch: { cwd: "/fixture/project", restriction: "published-ref" as const },
    source,
  },
  { label: "empty cwd", launch: { cwd: " ", restriction: "project-folder" as const }, source },
  {
    label: "missing GitHub source",
    launch: { cwd: "/fixture/project", restriction: "project-folder" as const },
    source: undefined,
  },
  {
    label: "non-GitHub source",
    launch: { cwd: "/fixture/project", restriction: "project-folder" as const },
    source: { ...source, repository: "https://gitlab.com/fixture/repo" },
  },
  {
    label: "empty branch",
    launch: { cwd: "/fixture/project", restriction: "project-folder" as const },
    source: { ...source, branch: " " },
  },
])("rejects an ineligible project launch before creating remote work (%s)", (fixture) =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const { cloudLaunchSource: _launch, cloudSource: _source, ...input } = h.input;
      yield* h.runtime.startTurn({
        ...input,
        ...(fixture.launch === undefined ? {} : { cloudLaunchSource: fixture.launch }),
        ...(fixture.source === undefined ? {} : { cloudSource: fixture.source }),
      });
      yield* Deferred.await(h.terminal);
      expect(h.counts()).toEqual({ starts: 0, sends: 0, reads: 0 });
      expect(h.events.find((event) => event.type === "turn.terminal")?.failure?.message).toContain(
        "GitHub project folder",
      );
    }),
  ),
);

it.effect.each([true, false, undefined])(
  "follow-up keeps legacy source flags without a project launch source (%s)",
  (included) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const prior = {
          ...h.saved,
          cloudTask: {
            ...h.saved.cloudTask,
            localChangesExcluded: true,
            ...(included === undefined ? {} : { localChangesIncluded: included }),
          },
        };
        const { cloudLaunchSource: _launch, ...input } = h.input;
        yield* h.runtime.startTurn({
          ...input,
          providerThread: prior,
          runtimePolicy: { ...policy, cwd: "/missing/deleted-project" },
          cloudSource: { ...source, repository: "https://github.com/fixture/other" },
        });
        yield* Deferred.await(h.terminal);
        expect(h.counts()).toEqual({ starts: 0, sends: 1, reads: 0 });
        for (const task of h.ledger) {
          expect(task.source).toEqual(source);
          expect(task.localChangesExcluded).toBe(true);
          expect(task.localChangesIncluded).toBe(included);
          expect(Object.hasOwn(task, "localChangesIncluded")).toBe(included !== undefined);
        }
        expect(h.controlCommands.map((command) => command.cwd)).toEqual([
          "/fixture/goat/control",
          "/fixture/goat/control",
        ]);
      }),
    ),
);

it.effect.each([true, false, undefined])(
  "recovery preserves legacy upload evidence without creating or sending (%s)",
  (included) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.runtime.resumeTurn!({
          ...h.attach,
          cloudTask: {
            ...h.saved.cloudTask,
            localChangesExcluded: true,
            ...(included === undefined ? {} : { localChangesIncluded: included }),
          },
        });
        yield* Deferred.await(h.read);
        yield* Deferred.succeed(h.deliver, undefined);
        yield* Deferred.await(h.terminal);
        expect(h.counts()).toEqual({ starts: 0, sends: 0, reads: 1 });
        for (const task of h.ledger) {
          expect(task.localChangesIncluded).toBe(included);
          expect(Object.hasOwn(task, "localChangesIncluded")).toBe(included !== undefined);
          expect(task.localChangesExcluded).toBe(true);
          expect(task.source).toEqual(source);
        }
      }),
    ),
);
