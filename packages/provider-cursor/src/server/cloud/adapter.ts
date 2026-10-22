import type { RunResult, SDKMessage } from "@cursor/sdk";
import {
  ProviderDriverKind,
  PositiveInt,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ProviderCapabilities,
  type ProviderInstanceId,
  type ProviderSetupError,
} from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import { makeProviderFailure } from "@goat/provider-core/server/failure";
import { turnScopedSelectionTransition } from "@goat/provider-core/server/selectionTransition";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { CursorProviderCapabilitiesV2 } from "../adapter.ts";
import { cursorSdkModelSelection } from "../sdkModel.ts";
import * as CursorCloudSdk from "./sdk.ts";

export const DRIVER = ProviderDriverKind.make("cursorCloud");
export const capabilities = {
  ...CursorProviderCapabilitiesV2,
  runtimePolicy: { enforcement: "client-boundary" },
  sessions: {
    ...CursorProviderCapabilitiesV2.sessions,
    executionLocation: "cloud",
    followUp: { supported: true },
    supportsProviderSwitchingViaHandoff: false,
  },
  threads: { ...CursorProviderCapabilitiesV2.threads, canReadThreadSnapshot: false },
  turns: { ...CursorProviderCapabilitiesV2.turns, supportsSteeringByInterruptRestart: false },
  streaming: {
    ...CursorProviderCapabilitiesV2.streaming,
    streamsAssistantText: false,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: false,
  },
  tools: {
    ...CursorProviderCapabilitiesV2.tools,
    exposesToolItemIds: false,
    emitsToolStarted: false,
    emitsToolCompleted: false,
    emitsToolOutput: false,
    supportsMcpTools: false,
  },
  planning: {
    ...CursorProviderCapabilitiesV2.planning,
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    ...CursorProviderCapabilitiesV2.subagents,
    supportsSubagents: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
  },
  context: {
    ...CursorProviderCapabilitiesV2.context,
    acceptsSyntheticUserContext: false,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: false,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: false,
  },
  checkpointing: {
    ...CursorProviderCapabilitiesV2.checkpointing,
    appCanCheckpointFilesystem: false,
    supportsNestedCheckpointScopes: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: { ...CursorProviderCapabilitiesV2.identity, nativeItemIds: "none" },
} satisfies OrchestrationV2ProviderCapabilities;

type Task = NonNullable<OrchestrationV2ProviderThread["cloudTask"]>;
type TurnInput = ProviderAdapter.ProviderAdapterV2TurnInput;
type AttachInput = Omit<TurnInput, "message" | "cloudLaunchSource">;
type Progress = { assistantText: string; text: string };
type Active = {
  input: AttachInput;
  thread: OrchestrationV2ProviderThread;
  turn: OrchestrationV2ProviderTurn;
  run: CursorCloudSdk.CloudRun;
  done: Deferred.Deferred<void>;
  fiber?: Fiber.Fiber<void, ProviderAdapter.ProviderAdapterV2Error>;
  stopRequested: boolean;
  finalized: boolean;
  observing: boolean;
  progress: Progress;
  lastPublishMs: number;
};

function repository(value: string): string | undefined {
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return;
    return `${url.origin}${url.pathname.replace(/\.git\/?$/, "").replace(/\/$/, "")}`;
  } catch {
    return;
  }
}

export function resultTask(task: Task, result: RunResult): Task {
  const { error: _observationError, ...reconciledTask } = task;
  const output = result.git?.branches.find(
    (item) => repository(item.repoUrl) === repository(task.source.repository),
  );
  const prUrl =
    output?.prUrl &&
    (() => {
      try {
        const url = new URL(output.prUrl);
        const source = new URL(task.source.repository);
        return url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          url.origin === source.origin &&
          url.pathname.startsWith(
            `${source.pathname.replace(/\.git\/?$/, "").replace(/\/$/, "")}/pull/`,
          )
          ? url.toString()
          : undefined;
      } catch {
        return;
      }
    })();
  return {
    ...reconciledTask,
    status:
      result.status === "finished"
        ? "succeeded"
        : result.status === "cancelled"
          ? "cancelled"
          : "failed",
    summary:
      result.result?.trim() ||
      (result.status === "finished"
        ? "Cursor Cloud completed without a returned summary."
        : result.status === "cancelled"
          ? "Cursor Cloud was cancelled."
          : "Cursor Cloud failed. Open the agent for details."),
    ...(output?.branch ? { branch: output.branch } : {}),
    ...(prUrl ? { prUrl } : {}),
    ...(result.status === "error"
      ? { error: "Cursor's agent hit an unexpected error before it finished." }
      : {}),
  };
}

const toolProgressLabels = new Map<string, readonly [string, string]>([
  ["run_terminal_cmd", ["Running a command", "Command"]],
  ["shell", ["Running a command", "Command"]],
  ["read_file", ["Reading a file", "File read"]],
  ["read", ["Reading a file", "File read"]],
  ["edit_file", ["Editing a file", "File edit"]],
  ["edit", ["Editing a file", "File edit"]],
  ["apply_patch", ["Editing a file", "File edit"]],
  ["grep", ["Searching the code", "Code search"]],
  ["ripgrep", ["Searching the code", "Code search"]],
  ["glob", ["Finding files", "File search"]],
  ["glob_file_search", ["Finding files", "File search"]],
  ["ls", ["Listing files", "File listing"]],
  ["web_search", ["Searching the web", "Web search"]],
  ["webSearch", ["Searching the web", "Web search"]],
  ["web_fetch", ["Reading a web page", "Web page read"]],
  ["webFetch", ["Reading a web page", "Web page read"]],
  ["task", ["Working on a delegated task", "Delegated task"]],
]);

function progressLine(text: string): string {
  const sentence =
    text
      .trim()
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?])\s+/)
      .at(-1) ?? "";
  if (sentence.length <= 240) return sentence;
  // Reserve one UTF-16 unit for the ellipsis without splitting a surrogate pair.
  const end = (sentence.codePointAt(238) ?? 0) > 0xffff ? 238 : 239;
  return `${sentence.slice(0, end)}…`;
}

export function progressText(previous: Progress, message: SDKMessage): Progress {
  switch (message.type) {
    case "assistant": {
      // SDK 1.0.35 assistant content is a text delta, not a display-status suffix.
      const delta = message.message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("");
      if (!delta) return previous;
      const accumulated = previous.assistantText + delta;
      let start = Math.max(0, accumulated.length - 8000);
      // A cut inside a surrogate pair must discard both units to stay within the cap.
      if ((accumulated.codePointAt(start - 1) ?? 0) > 0xffff) start += 1;
      const assistantText = accumulated.slice(start);
      return { assistantText, text: progressLine(assistantText) || previous.text };
    }
    case "thinking":
      return previous;
    case "tool_call": {
      const [running, finished] = toolProgressLabels.get(message.name) ?? ["Using a tool", "Tool"];
      return {
        ...previous,
        // The SDK accumulator starts a new assistant step after a completed tool.
        assistantText: message.status === "running" ? previous.assistantText : "",
        text:
          message.status === "running"
            ? `${running}.`
            : `${finished} ${message.status === "completed" ? "completed" : "failed"}.`,
      };
    }
    case "status": {
      const text = {
        CREATING: "Cursor Cloud is starting.",
        RUNNING: "Cursor Cloud is running.",
        FINISHED: "Cursor Cloud finished.",
        ERROR: "Cursor Cloud reported an error. Open the agent for details.",
        CANCELLED: "Cursor Cloud was cancelled.",
        EXPIRED: "Cursor Cloud expired.",
      }[message.status];
      return { ...previous, text };
    }
    case "task":
      return { ...previous, text: progressLine(message.text ?? "") || previous.text };
    default:
      return previous;
  }
}

export const makeCursorCloudAdapter = Effect.fn("makeCursorCloudAdapter")(function* (
  instanceId: ProviderInstanceId,
  requireApiKey: Effect.Effect<string, ProviderSetupError>,
) {
  const sdk = yield* CursorCloudSdk.CursorCloudSdk;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const protocol = (detail: string, cause?: CursorCloudSdk.CursorCloudSdkError) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: DRIVER,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const call = <A>(
    operation: CursorCloudSdk.CursorCloudSdkError["operation"],
    request: () => Promise<A>,
  ) =>
    CursorCloudSdk.request(operation, request).pipe(
      Effect.mapError((cause) => protocol(`Cursor Cloud ${operation} failed.`, cause)),
    );
  const key = requireApiKey.pipe(
    Effect.mapError(() => protocol("Cursor Cloud sign-in is unavailable.")),
  );

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId,
    driver: DRIVER,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: (opened) =>
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        const now = yield* DateTime.now;
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        let active: Active | undefined;
        const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
          Queue.offer(events, event).pipe(Effect.asVoid);
        const session = {
          id: opened.providerSessionId,
          driver: DRIVER,
          providerInstanceId: instanceId,
          status: "ready" as const,
          cwd: opened.runtimePolicy.cwd ?? "/",
          model: opened.modelSelection.model,
          capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const commit = (ctx: Active, task: Task, turn = ctx.turn) =>
          Effect.gen(function* () {
            const timestamp = yield* DateTime.now;
            const thread = {
              ...ctx.thread,
              cloudTask: { ...task, updatedAt: DateTime.formatIso(timestamp) },
              updatedAt: timestamp,
            };
            const persist = ctx.input.commitCloudTask;
            if (!persist)
              return yield* protocol("The shared cloud persistence hook is unavailable.");
            yield* persist(thread.cloudTask!, {
              nativeThreadRef: thread.nativeThreadRef,
              nativeConversationHeadRef: thread.nativeConversationHeadRef,
            });
            if (turn !== ctx.turn)
              yield* emit({
                type: "provider_turn.updated",
                driver: DRIVER,
                threadId: ctx.input.threadId,
                providerTurn: turn,
              });
            ctx.thread = thread;
            ctx.turn = turn;
          });
        const fresh = (ctx: Active) =>
          Effect.gen(function* () {
            const apiKey = yield* key;
            return yield* call("get-run", () =>
              sdk.getRun(ctx.run.id, {
                runtime: "cloud",
                agentId: ctx.run.agentId,
                apiKey,
              }),
            );
          });
        const finalize = (ctx: Active, result: RunResult) =>
          Effect.gen(function* () {
            if (ctx.finalized) return;
            const timestamp = yield* DateTime.now;
            const status =
              result.status === "finished"
                ? "completed"
                : result.status === "error"
                  ? "failed"
                  : ctx.stopRequested
                    ? "interrupted"
                    : "cancelled";
            const task = resultTask(
              { ...ctx.thread.cloudTask!, progress: ctx.progress.text },
              result,
            );
            const turn = {
              ...ctx.turn,
              status,
              completedAt: timestamp,
            } satisfies OrchestrationV2ProviderTurn;
            yield* commit(ctx, task, turn);
            yield* emit(
              status === "failed"
                ? {
                    type: "turn.terminal",
                    driver: DRIVER,
                    providerThreadId: ctx.thread.id,
                    providerTurnId: turn.id,
                    runOrdinal: PositiveInt.make(ctx.input.runOrdinal),
                    failureItemOrdinal: PositiveInt.make(ctx.input.providerTurnOrdinal * 100 + 2),
                    status,
                    failure: makeProviderFailure({ class: "provider_error" }),
                    threadDisposition: "reusable",
                  }
                : {
                    type: "turn.terminal",
                    driver: DRIVER,
                    providerThreadId: ctx.thread.id,
                    providerTurnId: turn.id,
                    runOrdinal: PositiveInt.make(ctx.input.runOrdinal),
                    status,
                    failure: null,
                    threadDisposition: "reusable",
                  },
            );
            ctx.finalized = true;
            if (active === ctx) active = undefined;
            yield* Deferred.succeed(ctx.done, undefined);
          });
        const poll = (ctx: Active) =>
          Effect.gen(function* () {
            while (!ctx.finalized) {
              const run = yield* fresh(ctx);
              if (run.status !== "running") {
                yield* finalize(ctx, yield* call("result", () => run.wait()));
                return;
              }
              const task = ctx.thread.cloudTask!;
              if (
                task.tracking !== "polled" ||
                task.status !== "running" ||
                task.error !== undefined
              ) {
                const { error: _observationError, ...reconciledTask } = task;
                yield* commit(ctx, { ...reconciledTask, status: "running", tracking: "polled" });
              }
              yield* Effect.sleep("15 seconds");
            }
          });
        const observe = (ctx: Active, agent?: CursorCloudSdk.CloudAgent) =>
          Effect.gen(function* () {
            if (agent) {
              const messages: AsyncIterable<SDKMessage> = {
                [Symbol.asyncIterator]() {
                  const iterator = ctx.run.stream();
                  return {
                    next: () => iterator.next(),
                    // Abort the owned stream before awaiting return with a pending next.
                    return: () => {
                      agent.close();
                      return iterator.return();
                    },
                  };
                },
              };
              yield* Stream.runForEach(
                Stream.fromAsyncIterable(messages, () =>
                  protocol("Cursor Cloud progress tracking was interrupted."),
                ),
                (message) =>
                  Effect.gen(function* () {
                    if (ctx.finalized) return;
                    if (message.agent_id !== ctx.run.agentId || message.run_id !== ctx.run.id)
                      return;
                    const next = progressText(ctx.progress, message);
                    const ms = yield* Clock.currentTimeMillis;
                    ctx.progress = next;
                    if (
                      ms - ctx.lastPublishMs < 250 ||
                      ctx.thread.cloudTask?.progress === next.text
                    )
                      return;
                    ctx.lastPublishMs = ms;
                    yield* commit(ctx, { ...ctx.thread.cloudTask!, progress: next.text });
                  }),
              ).pipe(Effect.ignore);
              // The observed handle may have synthesized an error for a timeout/disconnect.
              // Re-read remote status before deciding whether the task ended.
              agent.close();
            }
            yield* poll(ctx);
          }).pipe(
            Effect.catch(() =>
              Effect.gen(function* () {
                const timestamp = yield* DateTime.now;
                yield* commit(
                  ctx,
                  {
                    ...ctx.thread.cloudTask!,
                    status: "unknown",
                    error:
                      "Cloud tracking is unavailable. Work may continue; open the agent or restore sign-in.",
                  },
                  { ...ctx.turn, status: "failed", completedAt: timestamp },
                );
                yield* emit({
                  type: "turn.terminal",
                  driver: DRIVER,
                  providerThreadId: ctx.thread.id,
                  providerTurnId: ctx.turn.id,
                  runOrdinal: PositiveInt.make(ctx.input.runOrdinal),
                  failureItemOrdinal: PositiveInt.make(ctx.input.providerTurnOrdinal * 100 + 2),
                  status: "failed",
                  failure: makeProviderFailure({ class: "provider_error" }),
                  threadDisposition: "reusable",
                });
                ctx.finalized = true;
                if (active === ctx) active = undefined;
                yield* Deferred.succeed(ctx.done, undefined);
              }),
            ),
          );
        const launchObserver = (ctx: Active, agent?: CursorCloudSdk.CloudAgent) =>
          Effect.gen(function* () {
            active = ctx;
            ctx.observing = true;
            if (agent)
              yield* Scope.addFinalizer(
                scope,
                Effect.sync(() => agent.close()),
              );
            ctx.fiber = yield* observe(ctx, agent).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  ctx.observing = false;
                }),
              ),
              Effect.forkIn(scope),
            );
          });
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            if (active?.fiber) yield* Fiber.interrupt(active.fiber);
            yield* Queue.shutdown(events);
          }),
        );
        const unsupported = (detail: string) => Effect.fail(protocol(detail));

        const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
          instanceId,
          driver: DRIVER,
          providerSessionId: session.id,
          providerSession: session,
          events: Stream.fromEffectRepeat(Queue.take(events)),
          ensureThread: (input) =>
            Effect.gen(function* () {
              if (input.existingProviderThread)
                return { ...input.existingProviderThread, providerSessionId: session.id };
              const timestamp = yield* DateTime.now;
              return {
                id: ids.derive.providerThread({
                  driver: DRIVER,
                  nativeThreadId: `pending:${input.threadId}`,
                  providerInstanceId: instanceId,
                }),
                driver: DRIVER,
                providerInstanceId: instanceId,
                providerSessionId: session.id,
                appThreadId: input.threadId,
                ownerNodeId: null,
                nativeThreadRef: null,
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt: timestamp,
                updatedAt: timestamp,
              };
            }),
          resumeThread: (input) =>
            Effect.succeed({ ...input.providerThread, providerSessionId: session.id }),
          startTurn: (input) =>
            Effect.gen(function* () {
              if (active && !active.finalized)
                return yield* protocol(
                  "A Cursor Cloud run is already active or awaiting reconciliation.",
                );
              if (input.message.attachments.length > 0)
                return yield* protocol("Cursor Cloud currently accepts text-only messages.");
              if (!input.cloudSource || !input.commitCloudTask)
                return yield* protocol(
                  "Cloud source or persistence was not resolved by the shared base.",
                );
              const sandbox = input.runtimePolicy.sandboxPolicy;
              if (
                input.runtimePolicy.runtimeMode !== "full-access" ||
                (input.runtimePolicy.approvalPolicy !== undefined &&
                  input.runtimePolicy.approvalPolicy !== "never") ||
                (sandbox !== undefined &&
                  (typeof sandbox !== "object" ||
                    sandbox === null ||
                    !("type" in sandbox) ||
                    sandbox.type !== "dangerFullAccess"))
              ) {
                return yield* protocol(
                  "Cursor Cloud supports full access only; GOAT sandbox and approval overrides cannot be applied in the cloud.",
                );
              }
              const prior = input.providerThread.cloudTask;
              if (prior && (prior.status === "running" || prior.status === "unknown"))
                return yield* protocol(
                  "Reconcile the previous cloud submission before sending again.",
                );
              const source = prior?.source ?? input.cloudSource;
              if (
                !source.sha ||
                !/^[a-f0-9]{40,64}$/i.test(source.sha) ||
                repository(source.repository) === undefined
              ) {
                return yield* protocol(
                  "Cursor Cloud requires a published repository and remote tip SHA.",
                );
              }
              const sha = source.sha;
              const apiKey = yield* key;
              const agentId = input.providerThread.nativeThreadRef?.nativeId;
              const agent = yield* Effect.acquireRelease(
                call(agentId ? "resume" : "create", () =>
                  agentId
                    ? sdk.resume(agentId, { apiKey })
                    : sdk.create({
                        apiKey,
                        model: cursorSdkModelSelection(input.modelSelection),
                        name: `GOAT ${input.threadId}`,
                        cloud: {
                          repos: [{ url: source.repository, startingRef: sha }],
                          workOnCurrentBranch: false,
                          autoCreatePR: true,
                        },
                      }),
                ),
                (agent) => Effect.sync(() => agent.close()),
              ).pipe(Effect.provideService(Scope.Scope, scope));
              const timestamp = yield* DateTime.now;
              const submitting: Task = {
                ...(agentId && prior ? prior : { taskId: input.runId }),
                url: `https://cursor.com/agents/${encodeURIComponent(agent.agentId)}`,
                status: "submitting",
                tracking: "live",
                source,
                localChangesExcluded: prior?.localChangesExcluded ?? true,
                updatedAt: DateTime.formatIso(timestamp),
              };
              const thread = {
                ...input.providerThread,
                providerSessionId: session.id,
                nativeThreadRef: {
                  driver: DRIVER,
                  nativeId: agent.agentId,
                  strength: "strong" as const,
                },
                cloudTask: submitting,
                status: "active" as const,
                firstRunOrdinal:
                  input.providerThread.firstRunOrdinal ?? PositiveInt.make(input.runOrdinal),
                lastRunOrdinal: PositiveInt.make(input.runOrdinal),
                updatedAt: timestamp,
              };
              yield* input.commitCloudTask(submitting, {
                nativeThreadRef: thread.nativeThreadRef,
                nativeConversationHeadRef: thread.nativeConversationHeadRef,
              });
              const sent = yield* call("send", () =>
                agent.send(input.message.text, {
                  model: cursorSdkModelSelection(input.modelSelection),
                  idempotencyKey: `goat:${instanceId}:${input.runId}:${input.attemptId}`,
                }),
              ).pipe(
                Effect.tapError(() =>
                  input.commitCloudTask!({
                    ...submitting,
                    status: "unknown",
                    error:
                      "Submission outcome is unknown. Do not submit again; open the agent to reconcile.",
                  }),
                ),
              );
              const turn: OrchestrationV2ProviderTurn = {
                id: ids.derive.providerTurn({
                  driver: DRIVER,
                  nativeTurnId: `${instanceId}:${sent.id}`,
                }),
                providerThreadId: thread.id,
                nodeId: input.rootNodeId,
                runAttemptId: input.attemptId,
                nativeTurnRef: { driver: DRIVER, nativeId: sent.id, strength: "strong" },
                ordinal: PositiveInt.make(input.providerTurnOrdinal),
                status: "running",
                startedAt: timestamp,
                completedAt: null,
              };
              const ctx: Active = {
                input,
                thread,
                turn,
                run: sent,
                done: yield* Deferred.make<void>(),
                stopRequested: false,
                finalized: false,
                observing: false,
                progress: { assistantText: "", text: "" },
                lastPublishMs: 0,
              };
              // Commit accepted identities before exposing a safely recorded running task.
              const accepted: Task = {
                taskId: sent.id,
                acceptedAppRunId: input.runId,
                url: submitting.url!,
                status: "running",
                tracking: "live",
                source,
                localChangesExcluded: submitting.localChangesExcluded,
                ...(submitting.title === undefined ? {} : { title: submitting.title }),
                ...(submitting.prUrl === undefined ? {} : { prUrl: submitting.prUrl }),
                ...(submitting.branch === undefined ? {} : { branch: submitting.branch }),
                updatedAt: submitting.updatedAt,
              };
              yield* commit(ctx, accepted);
              yield* emit({
                type: "provider_turn.updated",
                driver: DRIVER,
                threadId: input.threadId,
                providerTurn: turn,
              });
              yield* launchObserver(ctx, agent);
            }),
          resumeTurn: (input) =>
            Effect.gen(function* () {
              let task = input.cloudTask;
              const agentId = input.providerThread.nativeThreadRef?.nativeId;
              if (!task || !input.commitCloudTask)
                return yield* protocol("Persisted cloud state is unavailable.");
              // A registered agent is known by its agent id; follow its latest run.
              if (task.attach === "registered" && agentId && task.taskId === agentId) {
                if (!sdk.listRuns)
                  return yield* protocol("This Cursor SDK cannot list an agent's runs.");
                const apiKey = yield* key;
                const latest = (yield* call("list", () =>
                  sdk.listRuns!(agentId, { runtime: "cloud", agentId, apiKey }),
                )).items[0];
                if (!latest) return yield* protocol("The Cursor agent has no runs to follow.");
                task = { ...task, taskId: latest.id };
                yield* input.commitCloudTask(task);
              }
              const runId = task.taskId;
              if (
                !agentId ||
                task.status === "submitting" ||
                task.acceptedAppRunId !== input.runId
              ) {
                yield* input.commitCloudTask({
                  ...task,
                  status: "unknown",
                  error: "Submission outcome is unknown; this task was not resubmitted.",
                });
                return yield* protocol(
                  "Cloud submission could not be reconciled; remote outcome is unknown.",
                );
              }
              if (active) {
                if (active.input.runId === input.runId && active.run.id === runId) return;
                return yield* protocol("Another Cursor Cloud observer owns this session.");
              }
              const apiKey = yield* key;
              const run = yield* call("get-run", () =>
                sdk.getRun(runId, { runtime: "cloud", agentId, apiKey }),
              );
              const startedAt =
                run.createdAt === undefined ? null : DateTime.makeUnsafe(run.createdAt);
              const turn: OrchestrationV2ProviderTurn = {
                id: ids.derive.providerTurn({
                  driver: DRIVER,
                  nativeTurnId: `${instanceId}:${runId}`,
                }),
                providerThreadId: input.providerThread.id,
                nodeId: input.rootNodeId,
                runAttemptId: input.attemptId,
                nativeTurnRef: { driver: DRIVER, nativeId: runId, strength: "strong" },
                ordinal: PositiveInt.make(input.providerTurnOrdinal),
                status: "running",
                startedAt,
                completedAt: null,
              };
              const ctx: Active = {
                input,
                thread: input.providerThread,
                turn,
                run,
                done: yield* Deferred.make<void>(),
                stopRequested: false,
                finalized: false,
                observing: false,
                progress: { assistantText: "", text: task.progress ?? "" },
                lastPublishMs: 0,
              };
              yield* emit({
                type: "provider_turn.updated",
                driver: DRIVER,
                threadId: input.threadId,
                providerTurn: turn,
              });
              yield* launchObserver(ctx);
            }),
          steerTurn: () =>
            unsupported("Queue a follow-up; Cursor Cloud does not support active steering."),
          interruptTurn: (input) =>
            Effect.gen(function* () {
              const ctx = active;
              const requestedTask = input.providerThread.cloudTask;
              if (
                !ctx ||
                ctx.turn.id !== input.providerTurnId ||
                ctx.thread.id !== input.providerThread.id ||
                ctx.thread.cloudTask?.acceptedAppRunId !== ctx.input.runId ||
                (requestedTask !== undefined &&
                  (requestedTask.status === "submitting" ||
                    requestedTask.acceptedAppRunId !== ctx.input.runId ||
                    requestedTask.taskId !== ctx.run.id))
              ) {
                return yield* protocol("The requested Cursor Cloud turn is not attached.");
              }
              // A registered run belongs to whoever launched it: Stop only stops following it.
              if (ctx.thread.cloudTask?.attach === "registered") {
                ctx.stopRequested = true;
                if (ctx.fiber) yield* Fiber.interrupt(ctx.fiber);
                if (ctx.finalized) return;
                const timestamp = yield* DateTime.now;
                const { error: _observationError, ...task } = ctx.thread.cloudTask;
                const turn = {
                  ...ctx.turn,
                  status: "interrupted",
                  completedAt: timestamp,
                } satisfies OrchestrationV2ProviderTurn;
                yield* commit(
                  ctx,
                  {
                    ...task,
                    tracking: "link-only",
                    progress:
                      "GOAT stopped following this run. It keeps running in Cursor; open it there to cancel it.",
                  },
                  turn,
                );
                yield* emit({
                  type: "turn.terminal",
                  driver: DRIVER,
                  providerThreadId: ctx.thread.id,
                  providerTurnId: turn.id,
                  runOrdinal: PositiveInt.make(ctx.input.runOrdinal),
                  status: "interrupted",
                  failure: null,
                  threadDisposition: "reusable",
                });
                ctx.finalized = true;
                if (active === ctx) active = undefined;
                yield* Deferred.succeed(ctx.done, undefined);
                return;
              }
              const apiKey = yield* key;
              yield* call("cancel", () =>
                sdk.cancelRun(ctx.run.id, { runtime: "cloud", agentId: ctx.run.agentId, apiKey }),
              );
              ctx.stopRequested = true;
              if (!ctx.observing) yield* launchObserver(ctx);
              // A failed/slow cancel must not fabricate terminal state. The observer confirms it.
              yield* Deferred.await(ctx.done);
            }),
          respondToRuntimeRequest: () =>
            unsupported("Cursor Cloud does not expose interactive GOAT approvals."),
          readThreadSnapshot: () =>
            unsupported(
              "Cursor Cloud history is retained in GOAT; native snapshots are unavailable.",
            ),
          rollbackThread: () => unsupported("Cursor Cloud cannot roll back this local workspace."),
          forkThread: () => unsupported("Start a new Cursor Cloud thread for separate work."),
        };
        return runtime;
      }),
  });
});
