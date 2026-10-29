import { bindingKeyFor, makeSessionEligibility } from "./channelSessionEligibility.ts";
/**
 * ChannelBotSession - GOAT Bot's warm session per conversation and requester: each task is its own
 * run there, follow-ups steer their task's run, and the session rotates only on a cold cache or a
 * full context.
 */

import {
  CHANNEL_RECEPTION_TAIL_LIMITS,
  type ChannelConversationId,
  ChannelRequester,
  type ChannelTask,
  type ChannelTaskId,
  CommandId,
  isChannelChildWorkActive,
  type MessageId,
  type OrchestrationV2Run,
  ProjectId,
  type RunId,
  type ThreadId,
} from "@goat/contracts";
import { resolveProjectSettings } from "@goat/shared/projectSettings";
import { prependStandingInstructions } from "@goat/shared/standingInstructions";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import { goatclawRoleTemplate } from "../goatclaw/RoleTemplates.ts";
import {
  type DispatchModeRefusal,
  DispatchModeLimit,
} from "../orchestration-v2/DispatchModeLimit.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as ServerSettings from "../serverSettings.ts";
import { requesterForDispatch } from "./channelDispatchAuthority.ts";
import { lowerRuntimeMode } from "./ChannelGateway.ts";
import * as ChannelChildWork from "./ChannelChildWork.ts";
import * as ChannelChildWorkStore from "./channelChildWorkStore.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as SlackChannelSettings from "./SlackChannelSettings.ts";
import { channelBotFilesFor, readChannelBotNotes } from "./channelBotNotes.ts";
import { canSeeTask, journalFor, RECALL_TASK_SCAN } from "./channelBotRecall.ts";
import {
  frozenSessionPrefix,
  GOAT_BOT_SESSION_RULES,
  sessionContextRevision,
  sessionRotationDue,
} from "./channelBotSessionBrief.ts";
import { channelNotesRevision, freezeChannelBrief } from "./channelBriefs.ts";
import {
  answerForwardIdsFor,
  goatBotSessionSharingFor,
  goatBotSessionThreadIdFor,
  questionIdFor,
  sessionLaunchIdsFor,
  sessionSendIdsFor,
  stopIdsFor,
  turnSteerIdsFor,
} from "./channelIds.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import { turnInstruction } from "./channelWorkerBrief.ts";
import { isThreadMissing } from "./channelWorkerObservation.ts";
import {
  isSessionTask,
  isTerminalRun,
  type SessionRow,
  sessionStore,
  sessionTaskRuns,
} from "./channelBotSessionRuns.ts";

const LIVE_SUBAGENT = new Set(["idle", "pending", "running", "waiting"]);
const STOP_REASON = "Stopped from GOAT Bot.";
const encodeRequester = Schema.encodeSync(Schema.fromJsonString(ChannelRequester));
const isLedgerError = Schema.is(ChannelLedger.ChannelLedgerError);

const requireTarget = (task: ChannelTask) =>
  task.target === undefined
    ? Effect.fail(
        new ChannelLedger.ChannelLedgerError({
          reason: "version_conflict",
          detail: "A GOAT Bot turn needs its dispatch target.",
        }),
      )
    : Effect.succeed(task.target);

const readRecords = (
  threads: ThreadManagement.ThreadManagementService["Service"],
  threadId: ThreadId,
) =>
  threads.getThreadRecords(threadId, [
    "runs",
    "messages",
    "providerTurns",
    "runtimeRequests",
    "subagents",
  ]);

const rejected = (failure: unknown) => {
  const tag = (failure as { readonly _tag?: string } | undefined)?._tag;
  return (
    tag === "OrchestratorCommandRejectedError" ||
    tag === "OrchestratorCommandPreviouslyRejectedError" ||
    tag === "ThreadManagementNoSteerableRunError"
  );
};

export class ChannelBotSession extends Context.Service<
  ChannelBotSession,
  {
    readonly eligible: (
      task: ChannelTask,
    ) => Effect.Effect<boolean, ChannelLedger.ChannelLedgerError>;
    /** Runs a GOAT Bot turn in its conversation's session; "deferred" retries on a later pass. */
    readonly serve: (
      stored: ChannelLedger.ChannelStoredTask,
      owner: string,
    ) => Effect.Effect<"served" | "deferred" | "failed", ChannelLedger.ChannelLedgerError>;
    /** Forwards a follow-up, answer or stop of a session task; false when the task is not one. */
    readonly forward: (
      pending: ChannelLedger.ChannelPendingEvent,
      owner: string,
    ) => Effect.Effect<boolean, ChannelLedger.ChannelLedgerError>;
  }
>()("goat/channels/ChannelBotSession") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ledger = yield* ChannelLedger.ChannelLedger;
  const eligible = yield* makeSessionEligibility;
  const slackSettings = yield* SlackChannelSettings.SlackChannelSettings;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const permissions = yield* Profiles.PermissionProfiles;
  const childWork = yield* ChannelChildWork.ChannelChildWork;
  const childWorkStore = yield* ChannelChildWorkStore.ChannelChildWorkStore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const botFiles = channelBotFilesFor(path, (yield* ServerConfig.ServerConfig).stateDir);
  // One binding decision at a time keeps generations and the one-current-row rule simple.
  const gate = yield* Semaphore.make(1);
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const { currentRow, setState, touch, writeIntent, recordRun } = sessionStore(sql);

  const fail = (stored: ChannelLedger.ChannelStoredTask, owner: string, summary: string) =>
    commitTransition(
      ledger,
      stored,
      {
        type: "task.failed",
        payload: { generation: stored.task.generation, reason: "launch_failed", summary },
      },
      { owner, narrate: true },
    ).pipe(Effect.as("failed" as const));

  const bindWorker = (
    stored: ChannelLedger.ChannelStoredTask,
    threadId: ThreadId,
    run: RunId,
    owner: string,
  ) =>
    Effect.flatMap(requireTarget(stored.task), (target) =>
      commitTransition(
        ledger,
        stored,
        {
          type: "task.worker.bound",
          payload: {
            worker: {
              environmentId: target.environmentId,
              threadId,
              runId: run,
              generation: stored.task.generation,
            },
          },
        },
        { owner },
      ),
    );

  /** Whether the session still has work in flight that a replacement would orphan. */
  const sessionBusy = Effect.fn("ChannelBotSession.sessionBusy")(function* (
    threadId: ThreadId,
    records: Effect.Success<ReturnType<typeof readRecords>>,
  ) {
    if (records.runs.some((run) => !isTerminalRun(run))) return true;
    if (records.runtimeRequests.some((request) => request.status === "pending")) return true;
    if (
      records.subagents.some(
        (task) =>
          LIVE_SUBAGENT.has(task.status) ||
          task.completionDelivery?.state === "pending" ||
          task.completionDelivery?.state === "claimed",
      )
    )
      return true;
    const tasks = yield* sql<{ readonly task_id: ChannelTaskId }>`
      SELECT DISTINCT task_id FROM channel_bot_session_runs WHERE thread_id = ${threadId}
    `;
    for (const { task_id } of tasks) {
      const stored = yield* ledger.getTask(task_id);
      if (stored === undefined) continue;
      // An unreadable record counts as active: a replacement must never orphan child work.
      const records = yield* childWorkStore
        .listForTask(task_id)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (
        records === undefined ||
        records.some(
          (record) =>
            record.generation === stored.task.generation && isChannelChildWorkActive(record.state),
        )
      )
        return true;
    }
    return false;
  });

  /** The six-part prefix for a new session, read once and frozen into its row. */
  const freezePrefix = Effect.fn("ChannelBotSession.freezePrefix")(function* (
    task: ChannelTask,
    message: string,
  ) {
    const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
    const standing = resolveProjectSettings(settings, (yield* requireTarget(task)).projectId)
      .settings.standingInstructions;
    const notes = yield* readChannelBotNotes(fileSystem, botFiles);
    const visible = yield* ledger
      .listTasks({ ownerId: task.requester.ownerId, limit: RECALL_TASK_SCAN })
      .pipe(
        Effect.map((page) =>
          page.tasks.filter((other) => canSeeTask(task.requester, other, task.conversationId)),
        ),
        Effect.orElseSucceed((): ReadonlyArray<ChannelTask> => []),
      );
    const tail = yield* ledger.readConversationTail(
      task.conversationId,
      CHANNEL_RECEPTION_TAIL_LIMITS.messages,
    );
    const open = (yield* ledger.listConversationTasks(task.conversationId)).filter(
      (other) =>
        other.taskId !== task.taskId &&
        (other.status === "received" ||
          other.status === "dispatching" ||
          other.status === "running" ||
          other.status === "waiting_input"),
    );
    return frozenSessionPrefix({
      standing: prependStandingInstructions(standing, GOAT_BOT_SESSION_RULES).text,
      notes,
      journal: journalFor(visible),
      tail: tail.flatMap((entry) =>
        entry.inputId === task.originInputId
          ? []
          : [
              { role: "user" as const, text: entry.text },
              ...(entry.replyText === undefined
                ? []
                : [{ role: "assistant" as const, text: entry.replyText }]),
            ],
      ),
      openWork: open.map((other) => ({ title: other.title, status: other.status })),
      message,
    });
  });

  const modeLimit = (task: ChannelTask, refused: Ref.Ref<DispatchModeRefusal | undefined>) =>
    Effect.provideService(DispatchModeLimit, {
      runtimeMode: task.requester.runtimeModeCeiling,
      interactionMode: "default",
      refused,
    });

  const launchGeneration = Effect.fn("ChannelBotSession.launchGeneration")(function* (
    stored: ChannelLedger.ChannelStoredTask,
    row: SessionRow,
    owner: string,
    requester: ChannelRequester,
  ) {
    const task = stored.task;
    const target = yield* requireTarget(task);
    const ids = sessionLaunchIdsFor(task.taskId, task.generation);
    const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
    // Only a requester at full access may act through the supervisor's owner profile.
    if (settings.goatclaw.enabled && requester.runtimeModeCeiling === "full-access")
      yield* permissions
        .bind(
          row.thread_id,
          goatclawRoleTemplate("supervisor").profileId,
          "channel:" + task.requester.ownerId,
        )
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("GOAT Bot session keeps the default profile", { cause: error }),
          ),
        );
    yield* writeIntent(row.thread_id, ids.messageId, task, "launch");
    const launched = yield* launches
      .launch({
        commandId: ids.commandId,
        threadId: row.thread_id,
        projectId: ProjectId.make(target.projectId),
        title: "GOAT Bot session",
        generateTitle: false,
        modelSelection: target.modelSelection,
        runtimeMode: lowerRuntimeMode(target.runtimeMode, requester.runtimeModeCeiling),
        interactionMode: target.interactionMode,
        workspaceStrategy: { type: "root" },
        initialMessage: {
          messageId: ids.messageId,
          text: row.context_text ?? "",
          attachments: [],
          ...(target.memoryGrantCeiling === undefined
            ? {}
            : { memoryGrantCeiling: target.memoryGrantCeiling }),
        },
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(Effect.result);
    // A launch can commit and still fail afterwards (reading its projection, say): look for its
    // run before deciding nothing started. Only a refusal or a thread that never appeared is final.
    const landed =
      launched._tag === "Success"
        ? launched.success.projection.runs
        : yield* threads.getThreadRecords(row.thread_id, ["runs"]).pipe(
            Effect.map((records) => records.runs),
            Effect.catch((cause) =>
              Effect.succeed(isThreadMissing(cause) ? ("missing" as const) : ("unknown" as const)),
            ),
          );
    if (launched._tag === "Failure") {
      yield* Effect.logWarning("GOAT Bot session launch failed", {
        taskId: task.taskId,
        cause: launched.failure,
      });
      if (landed === "missing" || rejected(launched.failure)) {
        yield* setState(row, "retired");
        return yield* fail(stored, owner, "GOAT Bot could not start its session.");
      }
      if (landed === "unknown") return "deferred" as const;
    }
    const run =
      typeof landed === "string"
        ? undefined
        : landed.find((candidate) => candidate.userMessageId === ids.messageId);
    if (run === undefined) return "deferred" as const;
    yield* recordRun(row.thread_id, ids.messageId, run, false);
    yield* setState(row, "active");
    yield* touch(row.thread_id);
    yield* bindWorker(stored, row.thread_id, run.id, owner);
    return "served" as const;
  });

  const queueInto = Effect.fn("ChannelBotSession.queueInto")(function* (
    stored: ChannelLedger.ChannelStoredTask,
    threadId: ThreadId,
    text: string,
    owner: string,
  ) {
    const task = stored.task;
    const ids = sessionSendIdsFor(task.taskId, task.generation);
    const projectId = ProjectId.make((yield* requireTarget(task)).projectId);
    yield* writeIntent(threadId, ids.messageId, task, "task");
    const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
    const sent = yield* threads
      .sendToThread({
        projectId,
        commandId: ids.commandId,
        threadId,
        messageId: ids.messageId,
        text,
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(modeLimit(task, refused), Effect.result);
    if (sent._tag === "Failure") {
      if ((yield* Ref.get(refused)) !== undefined || rejected(sent.failure))
        return yield* fail(stored, owner, "GOAT Bot's session did not take this request.");
      yield* Effect.logWarning("GOAT Bot session send failed; retrying", {
        taskId: task.taskId,
        cause: sent.failure,
      });
      return "deferred" as const;
    }
    yield* recordRun(threadId, ids.messageId, sent.success.run, false);
    yield* touch(threadId);
    yield* bindWorker(stored, threadId, sent.success.run.id, owner);
    return "served" as const;
  });

  const allocate = Effect.fn("ChannelBotSession.allocate")(function* (
    task: ChannelTask,
    key: string,
    sharing: string,
    driver: string | undefined,
    prefix: string,
  ) {
    const target = yield* requireTarget(task);
    const now = yield* nowIso;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const next = yield* sql<{ readonly generation: number }>`
          SELECT COALESCE(MAX(generation), 0) + 1 AS generation FROM channel_bot_sessions
          WHERE conversation_id = ${task.conversationId}
        `;
        const generation = next[0]?.generation ?? 1;
        const threadId = goatBotSessionThreadIdFor(
          task.conversationId as ChannelConversationId,
          generation,
        );
        yield* sql`
          INSERT INTO channel_bot_sessions (conversation_id, generation, binding_key, thread_id,
            task_id, task_generation, state, driver_kind, sharing, model_instance_id, model,
            requester_json, context_revision, context_text, created_at)
          VALUES (${task.conversationId}, ${generation}, ${key}, ${threadId},
            ${task.taskId}, ${task.generation}, 'starting', ${driver ?? null},
            ${sharing}, ${target.modelSelection.instanceId}, ${target.modelSelection.model},
            ${encodeRequester(task.requester)}, ${sessionContextRevision(prefix)}, ${prefix}, ${now})
        `;
        return yield* currentRow(key);
      }),
    );
  });

  const serveNow = Effect.fn("ChannelBotSession.serveNow")(function* (
    initial: ChannelLedger.ChannelStoredTask,
    owner: string,
  ) {
    const target = yield* requireTarget(initial.task);
    const driver = (yield* providers.getInstance(target.modelSelection.instanceId))?.driverKind;
    const sharing = goatBotSessionSharingFor(driver);
    // The requester as they stand now: a Slack grant lowered since the message arrived counts.
    const requester =
      (yield* requesterForDispatch(initial.task).pipe(
        Effect.provideService(ChannelLedger.ChannelLedger, ledger),
        Effect.provideService(SlackChannelSettings.SlackChannelSettings, slackSettings),
      )) ?? initial.task.requester;
    const key = bindingKeyFor(initial.task, target, sharing, requester);
    let row = yield* currentRow(key);
    const records =
      row === undefined
        ? Option.none()
        : yield* readRecords(threads, row.thread_id).pipe(Effect.option);
    // A task already sent into its session (a pass interrupted after the send) only binds again.
    if (row !== undefined && Option.isSome(records)) {
      const run = (yield* sessionTaskRuns(sql, row.thread_id, records.value, initial.task)).at(-1);
      if (run !== undefined) {
        yield* bindWorker(initial, row.thread_id, run.id, owner);
        return "served" as const;
      }
    }
    // A generation that never finished launching belongs to the task that started it: only that
    // task resumes its launch, while it can still run; otherwise the row is retired unused.
    if (
      row?.state === "starting" &&
      (row.task_id !== initial.task.taskId || row.task_generation !== initial.task.generation)
    ) {
      const starter = row.task_id === null ? undefined : yield* ledger.getTask(row.task_id);
      const launchedRuns = Option.isSome(records) ? records.value.runs.length : 0;
      if (
        launchedRuns === 0 &&
        starter !== undefined &&
        starter.task.generation === row.task_generation &&
        (starter.task.status === "received" || starter.task.status === "dispatching")
      )
        return "deferred" as const;
      if (launchedRuns > 0) yield* setState(row, "active");
      else yield* setState(row, "retired");
      row = yield* currentRow(key);
    }
    const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
    const message = turnInstruction(initial.task, botFiles, settings.goatclaw.enabled);
    const notesRevision =
      initial.task.briefVersion === undefined
        ? yield* channelNotesRevision(botFiles.notes).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
          )
        : null;
    const freeze = (text: string) =>
      freezeChannelBrief(ledger, initial, owner, text, {
        notesPath: botFiles.notes,
        notesRevision,
        skillsPath: botFiles.skills,
      });
    if (row?.state === "active") {
      const usage = Option.isNone(records)
        ? undefined
        : records.value.providerTurns
            .flatMap((turn) => (turn.tokenUsage === undefined ? [] : [turn.tokenUsage]))
            .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
      const due = sessionRotationDue(usage, DateTime.toEpochMillis(yield* DateTime.now));
      if (due === undefined) {
        const { stored } = yield* freeze(message);
        return yield* queueInto(stored, row.thread_id, message, owner);
      }
      if (Option.isSome(records) && (yield* sessionBusy(row.thread_id, records.value))) {
        yield* Effect.logInfo("GOAT Bot session rotation waits for its work", {
          reason: due,
          taskId: initial.task.taskId,
        });
        return "deferred" as const;
      }
      yield* setState(row, "retired");
      row = undefined;
    }
    if (row === undefined) {
      const prefix = yield* freezePrefix(initial.task, message);
      row = yield* allocate(initial.task, key, sharing, driver, prefix);
      if (row === undefined) return "deferred" as const;
    }
    const { stored } = yield* freeze(row.context_text ?? message);
    return yield* launchGeneration(stored, row, owner, requester);
  });

  const serve: ChannelBotSession["Service"]["serve"] = (initial, owner) =>
    gate
      .withPermits(1)(serveNow(initial, owner))
      .pipe(Effect.mapError(asLedgerError("serve")));

  const askRequester = Effect.fn("ChannelBotSession.askRequester")(function* (
    stored: ChannelLedger.ChannelStoredTask,
    text: string,
    owner: string,
  ) {
    return yield* commitTransition(
      ledger,
      stored,
      {
        type: "task.question.opened",
        payload: {
          question: {
            questionId: questionIdFor(stored.task.taskId, stored.task.version + 1),
            text,
            askedAt: yield* nowIso,
            ...(stored.task.requester.externalActorId === undefined
              ? {}
              : { requesterExternalActorId: stored.task.requester.externalActorId }),
          },
        },
      },
      { owner, narrate: true, pendingAnswerMessageId: null },
    );
  });

  /** One message into the task's own live run, else as the task's next run; never another's. */
  const sendForTask = Effect.fn("ChannelBotSession.sendForTask")(function* (
    stored: ChannelLedger.ChannelStoredTask,
    threadId: ThreadId,
    text: string,
    ids: {
      readonly first: ReturnType<typeof turnSteerIdsFor>;
      readonly queued: ReturnType<typeof turnSteerIdsFor>;
    },
  ) {
    const task = stored.task;
    const projectId = ProjectId.make((yield* requireTarget(task)).projectId);
    const records = yield* readRecords(threads, threadId);
    const own = yield* sessionTaskRuns(sql, threadId, records, task);
    const current = own.at(-1);
    // A replay after a crash finds the run its first send started instead of sending again.
    const already = records.runs.find(
      (run) =>
        run.userMessageId === ids.first.messageId || run.userMessageId === ids.queued.messageId,
    );
    if (already !== undefined) {
      yield* recordRun(threadId, already.userMessageId as MessageId, already, false);
      return { _tag: "sent", run: already } as const;
    }
    // A steer recorded before a crash replays under its own ids, whatever runs now: the thread
    // answers an accepted one with the run it joined, and refuses one that never landed.
    const firstIntent = yield* sql<{ readonly steered_into_run_id: RunId | null }>`
      SELECT steered_into_run_id FROM channel_bot_session_runs
      WHERE thread_id = ${threadId} AND message_id = ${ids.first.messageId}
    `;
    const steeredInto = records.runs.find((run) => run.id === firstIntent[0]?.steered_into_run_id);
    if (steeredInto !== undefined) return { _tag: "sent", run: steeredInto } as const;
    // A person stopped this task's run in GOAT; sending would start it again.
    if (current?.status === "cancelled" && firstIntent.length === 0)
      return { _tag: "stopped", run: current } as const;
    const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
    const attempt = (mode: "steer" | "queue", which: ReturnType<typeof turnSteerIdsFor>) =>
      writeIntent(threadId, which.messageId, task, "followup").pipe(
        Effect.andThen(
          threads
            .sendToThread({
              projectId,
              commandId: which.commandId,
              threadId,
              messageId: which.messageId,
              text,
              attachments: [],
              mode,
              ...(mode === "steer" && current !== undefined ? { targetRunId: current.id } : {}),
              createdBy: "user",
              creationSource: "server",
            })
            .pipe(modeLimit(task, refused), Effect.result),
        ),
      );
    let which = ids.first;
    let sent =
      current !== undefined &&
      (firstIntent.length > 0 || (!isTerminalRun(current) && current.status !== "queued"))
        ? yield* attempt("steer", ids.first)
        : undefined;
    if (
      sent === undefined ||
      (sent._tag === "Failure" &&
        rejected(sent.failure) &&
        (yield* Ref.get(refused)) === undefined &&
        ids.queued.messageId !== ids.first.messageId)
    ) {
      which = ids.queued;
      sent = yield* attempt("queue", ids.queued);
    }
    if (sent._tag === "Failure")
      return { _tag: "failed", failure: sent.failure, refusal: yield* Ref.get(refused) } as const;
    yield* recordRun(
      threadId,
      which.messageId,
      sent.success.run,
      sent.success.delivery === "steered",
    );
    return { _tag: "sent", run: sent.success.run } as const;
  });

  /**
   * Binds the task to the run that took its message, lifting the completion fence the message set
   * in the same write. False when another write moved the task first; the next pass tries again.
   */
  const bindAfterSend = Effect.fn("ChannelBotSession.bindAfterSend")(function* (
    taskId: ChannelTaskId,
    own: ReadonlyArray<string>,
    run: OrchestrationV2Run,
    owner: string,
  ) {
    const latest = yield* ledger.getTask(taskId);
    if (latest?.task.worker === undefined) return true;
    const ownsFence =
      latest.pendingAnswerMessageId !== undefined && own.includes(latest.pendingAnswerMessageId);
    if (!ownsFence && latest.task.worker.runId === run.id) return true;
    const bound = yield* commitTransition(
      ledger,
      latest,
      { type: "task.worker.bound", payload: { worker: { ...latest.task.worker, runId: run.id } } },
      { owner, ...(ownsFence ? { pendingAnswerMessageId: null } : {}) },
    );
    return bound !== undefined;
  });

  const forwardFollowUp = Effect.fn("ChannelBotSession.forwardFollowUp")(function* (
    pending: ChannelLedger.ChannelPendingEvent,
    event: Extract<ChannelLedger.ChannelPendingEvent["event"], { type: "task.followup.received" }>,
    owner: string,
  ) {
    const done = ledger.completeForward({ owner, sequence: pending.sequence });
    const stored = yield* ledger.getTask(event.taskId);
    const worker = stored?.task.worker;
    if (
      stored === undefined ||
      worker === undefined ||
      (stored.task.status !== "running" && stored.task.status !== "waiting_input") ||
      stored.task.generation !== event.payload.generation
    )
      return yield* done;
    if (
      yield* ledger.hasEarlierPendingForward({ taskId: event.taskId, sequence: pending.sequence })
    )
      return;
    const ids = {
      first: turnSteerIdsFor(event.payload.inputId, "first"),
      queued: turnSteerIdsFor(event.payload.inputId, "queued"),
    };
    const result = yield* sendForTask(
      stored,
      worker.threadId,
      "Follow-up from " + event.payload.from + ": " + event.payload.text,
      ids,
    );
    const own = [ids.first.messageId, ids.queued.messageId];
    if (result._tag === "failed") {
      if (result.refusal === undefined && !rejected(result.failure)) {
        yield* Effect.logWarning("GOAT Bot session follow-up failed; retrying", {
          taskId: event.taskId,
          cause: result.failure,
        });
        return;
      }
      const asked = yield* askRequester(
        (yield* ledger.getTask(event.taskId)) ?? stored,
        "The session didn't take your follow-up (\"" +
          event.payload.text +
          '"). Say it again, or open the thread in GOAT.',
        owner,
      );
      if (asked !== undefined) yield* done;
      return;
    }
    // A stopped run is not restarted: the follow-up is dropped and its fence lifted.
    if (yield* bindAfterSend(event.taskId, own, result.run, owner)) yield* done;
  });

  const forwardAnswer = Effect.fn("ChannelBotSession.forwardAnswer")(function* (
    pending: ChannelLedger.ChannelPendingEvent,
    owner: string,
  ) {
    const event = pending.event;
    const done = ledger.completeForward({ owner, sequence: pending.sequence });
    const stored = yield* ledger.getTask(event.taskId);
    if (event.type !== "task.question.answered" || stored?.task.worker === undefined)
      return yield* done;
    const ids = answerForwardIdsFor(event.eventId);
    const result = yield* sendForTask(
      stored,
      stored.task.worker.threadId,
      "Answer from " + stored.task.requester.displayName + ": " + event.payload.answer,
      { first: ids, queued: ids },
    );
    if (result._tag === "failed") {
      if (result.refusal === undefined && !rejected(result.failure)) return;
      const asked = yield* askRequester(
        stored,
        "The session didn't take your answer (\"" +
          event.payload.answer +
          '"). Answer again, or answer in the thread.',
        owner,
      );
      if (asked !== undefined) yield* done;
      return;
    }
    if (yield* bindAfterSend(event.taskId, [ids.messageId], result.run, owner)) yield* done;
  });

  /** Stops one task's runs and the children they started; other tasks in the session run on. */
  const stopTask = Effect.fn("ChannelBotSession.stopTask")(function* (
    pending: ChannelLedger.ChannelPendingEvent,
    owner: string,
  ) {
    const done = ledger.completeForward({ owner, sequence: pending.sequence });
    const stored = yield* ledger.getTask(pending.event.taskId);
    if (stored?.task.target === undefined) return yield* done;
    const task = stored.task;
    const sessions = yield* sql<{ readonly thread_id: ThreadId }>`
      SELECT DISTINCT thread_id FROM channel_bot_session_runs
      WHERE task_id = ${task.taskId} AND task_generation = ${task.generation}
    `;
    const attempt = yield* ledger.stopAttempt(pending.event.eventId);
    const ids = stopIdsFor(pending.event.eventId, attempt === 0 ? undefined : "attempt-" + attempt);
    let retry = false;
    for (const { thread_id: threadId } of sessions) {
      const records = yield* readRecords(threads, threadId);
      const runs = yield* sessionTaskRuns(sql, threadId, records, task);
      for (const run of runs.filter((candidate) => !isTerminalRun(candidate))) {
        const commandId = CommandId.make(ids.interrupt + ":" + run.id);
        const stopped = yield* threads
          .dispatch(
            run.status === "queued"
              ? { type: "queued-run.cancel", commandId, threadId, runId: run.id }
              : {
                  type: "run.interrupt",
                  commandId,
                  threadId,
                  runId: run.id,
                  reason: STOP_REASON,
                  holdQueue: false,
                },
          )
          .pipe(Effect.result);
        if (stopped._tag === "Failure") {
          yield* Effect.logWarning("GOAT Bot session run stop failed; retrying", {
            taskId: task.taskId,
            cause: stopped.failure,
          });
          if (rejected(stopped.failure))
            yield* ledger.advanceStopAttempt({
              eventId: pending.event.eventId,
              from: attempt,
              now: yield* nowIso,
            });
          retry = true;
        }
      }
      // Children read after the interrupts, so a delegate that landed meanwhile is stopped too.
      const after = yield* readRecords(threads, threadId);
      const afterRuns = yield* sessionTaskRuns(sql, threadId, after, task);
      if (afterRuns.some((run) => !isTerminalRun(run))) retry = true;
      const runIds = new Set<string>(afterRuns.map((run) => run.id));
      const owned = after.subagents.filter(
        (child) =>
          child.origin === "app_owned" &&
          child.runId !== null &&
          runIds.has(child.runId) &&
          child.promotedAt === undefined,
      );
      const live = owned.filter((child) => LIVE_SUBAGENT.has(child.status));
      if (live.length > 0) retry = true;
      const local = live.flatMap((child) =>
        child.childThreadId === null ? [] : [child.childThreadId],
      );
      if (local.length > 0) {
        const stoppedChildren = yield* threads
          .stopDelegatedTasks({
            threadId,
            commandId: ids.subagents,
            childThreadIds: local,
            reason: STOP_REASON,
          })
          .pipe(Effect.result);
        if (stoppedChildren._tag === "Failure") retry = true;
      }
      const coordinator = yield* Effect.serviceOption(
        RemoteDispatchCoordinator.RemoteDispatchCoordinator,
      );
      for (const child of live) {
        if (child.remote === undefined || Option.isNone(coordinator)) continue;
        const cancelled = yield* coordinator.value
          .cancel(child.remote.correlationId, Effect.succeed(task.requester.runtimeModeCeiling))
          .pipe(Effect.result);
        if (cancelled._tag === "Failure") retry = true;
      }
      // A wake owed to a stopped task would restart it; drop each one, live child or not. A cloud
      // task keeps its promised result for the observer to record (task_cancel's rule), and an
      // unreadable child is decided on a later pass rather than guessed.
      for (const child of owned) {
        const state = child.completionDelivery?.state;
        if (state !== "pending" && state !== "claimed") continue;
        const cloud: boolean | "unknown" =
          child.childThreadId === null
            ? false
            : yield* threads
                .getThreadRecords(child.childThreadId, ["runs", "providerThreads"])
                .pipe(
                  Effect.map((records) => {
                    const run =
                      ThreadManagement.latestActiveRun(records) ??
                      ThreadManagement.latestRun(records);
                    return (
                      records.providerThreads.find(
                        (provider) => provider.id === run?.providerThreadId,
                      )?.cloudTask !== undefined
                    );
                  }),
                  Effect.catch((cause) =>
                    Effect.succeed(isThreadMissing(cause) ? false : ("unknown" as const)),
                  ),
                );
        if (cloud === "unknown") retry = true;
        if (cloud !== false) continue;
        const disposed = yield* threads
          .dispatch({
            type: "delegated_task.completion-delivery.dispose",
            commandId: CommandId.make(ids.subagents + ":dispose:" + child.id),
            parentThreadId: threadId,
            taskId: child.id,
          })
          .pipe(Effect.result);
        if (disposed._tag === "Failure") retry = true;
      }
    }
    const records = yield* childWork
      .cancelForTask({
        taskId: task.taskId,
        generation: task.generation,
        stopEventId: pending.event.eventId,
        attempt,
        reason: STOP_REASON,
      })
      .pipe(Effect.result);
    if (records._tag === "Failure" || records.success === "retry") retry = true;
    if (!retry) yield* done;
  });

  const forward: ChannelBotSession["Service"]["forward"] = Effect.fn("ChannelBotSession.forward")(
    function* (pending, owner) {
      const stored = yield* ledger.getTask(pending.event.taskId);
      if (stored === undefined || !isSessionTask(stored.task)) return false;
      const event = pending.event;
      if (event.type === "task.followup.received") yield* forwardFollowUp(pending, event, owner);
      else if (event.type === "task.cancelled")
        yield* gate.withPermits(1)(stopTask(pending, owner));
      else if (event.type === "task.question.answered") yield* forwardAnswer(pending, owner);
      else yield* ledger.completeForward({ owner, sequence: pending.sequence });
      return true;
    },
    Effect.mapError(asLedgerError("forward")),
  );

  return ChannelBotSession.of({ serve, forward, eligible });
});

const asLedgerError = (operation: string) => (cause: unknown) =>
  isLedgerError(cause)
    ? cause
    : new ChannelLedger.ChannelLedgerError({
        reason: "persistence",
        detail: "GOAT Bot session " + operation + " failed.",
        cause,
      });

export const layer = Layer.effect(ChannelBotSession, make).pipe(Layer.provide(Profiles.layer));
