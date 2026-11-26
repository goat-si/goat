import { botToolsRefusal } from "./channelBotTools.ts";
import { asLedgerError, readRecords, rejected, requireTarget } from "./channelBotSessionRecords.ts";
import { bindingKeyFor, makeSessionEligibility } from "./channelSessionEligibility.ts";
/** Warm sessions are bound per conversation, bot and requester. */
import {
  type ChannelConversationId,
  type ChannelInputId,
  ChannelRequester,
  type ChannelTask,
  type ChannelTaskId,
  type ChatAttachment,
  CommandId,
  isChannelChildWorkActive,
  type MessageId,
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
import {
  makeDispatchConfirmation,
  requesterForDispatch,
  sessionMemoryCeiling,
} from "./channelDispatchAuthority.ts";
import { lowerRuntimeMode } from "./ChannelGateway.ts";
import * as ChannelChildWork from "./ChannelChildWork.ts";
import * as ChannelChildWorkStore from "./channelChildWorkStore.ts";
import { ChannelLaunchWakes, owesLaunched, ownResultRuns } from "./channelLaunchedResults.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as SlackChannelSettings from "./SlackChannelSettings.ts";
import { channelBotFilesFor } from "./channelBotNotes.ts";
import {
  freezeSessionPrefix,
  visibleOpenWork,
  formatOpenWork,
  GOAT_BOT_SESSION_RULES,
  sessionContextRevision,
  sessionTurnBrief,
} from "./channelBotSessionBrief.ts";
import * as Rotation from "./channelBotSessionRotation.ts";
import * as ChannelBotProfiles from "./ChannelBotProfiles.ts";
import { freezeChannelBrief } from "./channelBriefs.ts";
import {
  answerForwardIdsFor,
  goatBotSessionSharingFor,
  goatBotSessionThreadIdFor,
  sessionLaunchIdsFor,
  sessionSendIdsFor,
  stopIdsFor,
  turnSteerIdsFor,
  toolSteerIdsFor,
} from "./channelIds.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import { refuseForward } from "./channelForwardRefusal.ts";
import * as SenderAuthority from "./channelSenderAuthority.ts";
import { bindAfterSend } from "./channelSessionBind.ts";
import { sessionForwardDelivery } from "./channelSessionForwardEvent.ts";
import { canReadChannelBotNotes } from "./channelBotNoteAccess.ts";
import { sessionCarriesNotes } from "./channelProviderBrief.ts";
import { sessionFollowUpText } from "./channelWorkerBrief.ts";
import { isThreadMissing } from "./channelWorkerObservation.ts";
import {
  isSessionTask,
  isTerminalRun,
  type SessionRow,
  sessionStore,
  sessionTaskRuns,
  steersInto,
} from "./channelBotSessionRuns.ts";

const LIVE_SUBAGENT = new Set(["idle", "pending", "running", "waiting"]);
const STOP_REASON = "Stopped from GOAT Bot.";
const encodeRequester = Schema.encodeSync(Schema.fromJsonString(ChannelRequester));
type DispatchConfirmation = Effect.Success<ReturnType<typeof makeDispatchConfirmation>>;

export class ChannelBotSession extends Context.Service<
  ChannelBotSession,
  {
    readonly eligible: Effect.Success<typeof makeSessionEligibility>;
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
  const launched = { threads, sql, watch: (yield* ChannelLaunchWakes).watch };
  const profiles = yield* ChannelBotProfiles.ChannelBotProfiles;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  // One binding decision at a time keeps generations and the one-current-row rule simple.
  const gate = yield* Semaphore.make(1);
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const { currentRow, setState, touch, writeIntent, recordRun } = sessionStore(sql);

  const fail = (
    stored: ChannelLedger.ChannelStoredTask,
    owner: string,
    summary: string,
    reason: "launch_failed" | "permission_changed" = "launch_failed",
  ) =>
    commitTransition(
      ledger,
      stored,
      {
        type: "task.failed",
        payload: { generation: stored.task.generation, reason, summary },
      },
      { owner, narrate: true },
    ).pipe(Effect.as("failed" as const));

  const failPermission = (stored: ChannelLedger.ChannelStoredTask, owner: string) =>
    fail(
      stored,
      owner,
      "The requester’s permission to start this work changed.",
      "permission_changed",
    );

  const dispatchRequester = (task: ChannelTask) =>
    requesterForDispatch(task).pipe(
      Effect.provideService(ChannelLedger.ChannelLedger, ledger),
      Effect.provideService(SlackChannelSettings.SlackChannelSettings, slackSettings),
    );

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
      const launches = yield* childWorkStore
        .listForTask(task_id)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (
        launches === undefined ||
        launches.some(
          (record) =>
            record.generation === stored.task.generation && isChannelChildWorkActive(record.state),
        )
      )
        return true;
      // A coding thread that finished owes its result until its wake has run on this session.
      if (yield* owesLaunched(launched, threadId, stored.task, launches)) return true;
    }
    return false;
  });

  const sentRun = Effect.fn("ChannelBotSession.sentRun")(function* (task: ChannelTask) {
    const sessions = yield* sql<{ readonly thread_id: ThreadId }>`
      SELECT DISTINCT thread_id FROM channel_bot_session_runs
      WHERE task_id = ${task.taskId} AND task_generation = ${task.generation}
    `;
    let unreadable = false;
    for (const { thread_id: threadId } of sessions) {
      const records = yield* readRecords(threads, threadId).pipe(
        Effect.asSome,
        Effect.catch((cause) =>
          Effect.succeed(isThreadMissing(cause) ? Option.none() : ("unknown" as const)),
        ),
      );
      if (records === "unknown") {
        unreadable = true;
        continue;
      }
      if (Option.isNone(records)) continue;
      const run = (yield* sessionTaskRuns(sql, threadId, records.value, task)).at(-1);
      if (run !== undefined) return { threadId, runId: run.id };
    }
    return unreadable ? ("unknown" as const) : undefined;
  });

  const modeLimit = (
    requester: Pick<ChannelRequester, "runtimeModeCeiling">,
    refused: Ref.Ref<DispatchModeRefusal | undefined>,
  ) =>
    Effect.provideService(DispatchModeLimit, {
      runtimeMode: requester.runtimeModeCeiling,
      interactionMode: "default",
      refused,
    });

  const inputAttachments = (inputId: ChannelInputId) =>
    ledger
      .getInput(inputId)
      .pipe(
        Effect.map((stored): ReadonlyArray<ChatAttachment> => stored?.message.attachments ?? []),
      );

  const launchGeneration = Effect.fn("ChannelBotSession.launchGeneration")(function* (
    stored: ChannelLedger.ChannelStoredTask,
    row: SessionRow,
    owner: string,
    requester: ChannelRequester,
    attachments: ReadonlyArray<ChatAttachment>,
    confirmation: DispatchConfirmation,
  ) {
    const task = stored.task;
    const target = yield* requireTarget(task);
    const memoryGrantCeiling = sessionMemoryCeiling(requester, target);
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
    const profile = yield* Effect.option(
      ChannelBotProfiles.readProfileRecord(sql, stored.ownerId, stored.botId),
    );
    const launched = yield* launches
      .launch({
        commandId: ids.commandId,
        threadId: row.thread_id,
        projectId: ProjectId.make(target.projectId),
        title: Option.getOrUndefined(profile)?.name ?? "GOAT Bot session",
        generateTitle: false,
        modelSelection: target.modelSelection,
        runtimeMode: lowerRuntimeMode(target.runtimeMode, requester.runtimeModeCeiling),
        interactionMode: target.interactionMode,
        workspaceStrategy: { type: "root" },
        ...confirmation.options,
        initialMessage: {
          messageId: ids.messageId,
          text: task.instruction,
          attachments,
          ...(memoryGrantCeiling === "none" ? {} : { memoryGrantCeiling }),
        },
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(Effect.result);
    if (launched._tag === "Failure" && (yield* confirmation.refused)) {
      yield* setState(row, "retired");
      return yield* failPermission(stored, owner);
    }
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
    owner: string,
    requester: ChannelRequester,
    attachments: ReadonlyArray<ChatAttachment>,
    confirmation: DispatchConfirmation,
  ) {
    const task = stored.task;
    const ids = sessionSendIdsFor(task.taskId, task.generation);
    const projectId = ProjectId.make((yield* requireTarget(task)).projectId);
    const memoryGrantCeiling = sessionMemoryCeiling(requester, task.target);
    yield* writeIntent(threadId, ids.messageId, task, "task");
    const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
    const sent = yield* threads
      .sendToThread({
        projectId,
        commandId: ids.commandId,
        threadId,
        messageId: ids.messageId,
        text: task.instruction,
        attachments,
        mode: "queue",
        ...confirmation.options,
        ...(memoryGrantCeiling === "none" ? {} : { memoryGrantCeiling }),
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(modeLimit(requester, refused), Effect.result);
    if (sent._tag === "Failure") {
      if (yield* confirmation.refused) return yield* failPermission(stored, owner);
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
    requester: ChannelRequester,
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
            ${encodeRequester(requester)}, ${sessionContextRevision(prefix)}, ${prefix}, ${now})
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
    const instance = yield* providers.getInstance(target.modelSelection.instanceId);
    const driver = instance?.driverKind;
    const sharing = goatBotSessionSharingFor(driver);
    const sent = yield* sentRun(initial.task);
    if (sent === "unknown") return "deferred" as const;
    if (sent !== undefined) {
      yield* sql`
        UPDATE channel_bot_sessions SET state = 'active', version = version + 1
        WHERE thread_id = ${sent.threadId} AND state = 'starting'
      `;
      yield* bindWorker(initial, sent.threadId, sent.runId, owner);
      return "served" as const;
    }
    const requester = yield* dispatchRequester(initial.task);
    if (requester === undefined) return yield* failPermission(initial, owner);
    const identity = yield* Effect.option(profiles.identity(initial.ownerId, initial.botId));
    if (Option.isNone(identity)) return yield* fail(initial, owner, Rotation.PROFILE_UNREADABLE);
    const refusal = botToolsRefusal(
      identity.value,
      instance?.displayName ?? target.modelSelection.instanceId,
    );
    if (refusal !== undefined) return yield* fail(initial, owner, refusal, "permission_changed");
    const memoryGrantCeiling = sessionMemoryCeiling(requester, target);
    const ceiling = { ...target, memoryGrantCeiling };
    const key = bindingKeyFor(initial.task, ceiling, sharing, requester, initial.botId);
    let row = yield* currentRow(key);
    const read = yield* Rotation.readSessionRecords(threads, row?.thread_id);
    const records = read === "unknown" ? Option.none() : read;
    // A generation that never finished launching belongs to the task that started it: only that
    // task resumes its launch, while it can still run; otherwise the row is retired unused.
    if (
      row?.state === "starting" &&
      (row.task_id !== initial.task.taskId || row.task_generation !== initial.task.generation)
    ) {
      if (read === "unknown") return "deferred" as const;
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
    const includePaused = yield* ledger.inputMemoryPaused(initial.task.originInputId);
    const openWork = yield* ledger.tasksForSessionHistory(
      visibleOpenWork(
        yield* ledger.listConversationTasks(initial.task.conversationId),
        initial.task,
        requester,
      ),
      includePaused,
    );
    const botFiles = channelBotFilesFor(path, stateDir, initial.botId);
    const { notes, instruction, context } = yield* sessionTurnBrief(
      initial.task,
      requester,
      botFiles,
      settings.goatclaw.enabled,
      memoryGrantCeiling,
    ).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
    const message = instruction + "\n\n" + formatOpenWork(openWork);
    const attachments = yield* inputAttachments(initial.task.originInputId);
    const freeze = (text: string) => freezeChannelBrief(ledger, initial, owner, text, context);
    const confirm = (holdsNotes: boolean) =>
      makeDispatchConfirmation(
        context.notesPath !== undefined || holdsNotes,
        dispatchRequester(initial.task).pipe(
          Effect.map(
            (current) =>
              current !== undefined &&
              canReadChannelBotNotes(current) &&
              sessionMemoryCeiling(current, target) === memoryGrantCeiling,
          ),
        ),
      );
    if (row?.state === "active") {
      const usage = Rotation.latestTurnUsage(records);
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const current = { identity: identity.value, notes: notes?.standing };
      const due = Rotation.sessionRotationReason(usage, nowMs, row.context_text, current);
      if (due === undefined) {
        const { stored, brief } = yield* freeze(message);
        return yield* queueInto(
          stored,
          row.thread_id,
          owner,
          requester,
          attachments,
          yield* confirm(
            brief.context.notesPath !== undefined ||
              (yield* sessionCarriesNotes(sql, row.thread_id)),
          ),
        );
      }
      const busy = Option.isSome(records) && (yield* sessionBusy(row.thread_id, records.value));
      if (read === "unknown" || busy) {
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
      const latestSettings = yield* serverSettings.getSettings.pipe(Effect.orDie);
      const { standingInstructions } = resolveProjectSettings(
        latestSettings,
        target.projectId,
      ).settings;
      const frozen = yield* freezeSessionPrefix(
        ledger,
        initial.task,
        initial.botId,
        prependStandingInstructions(standingInstructions, GOAT_BOT_SESSION_RULES).text,
        requester,
        message,
        notes?.standing ?? "",
        openWork,
        includePaused,
      );
      const prefix = Rotation.withIdentity(identity.value, frozen);
      row = yield* allocate(initial.task, requester, key, sharing, driver, prefix);
      if (row === undefined) return "deferred" as const;
    }
    const { stored, brief } = yield* freeze(row.context_text ?? message);
    return yield* launchGeneration(
      stored,
      row,
      owner,
      requester,
      attachments,
      yield* confirm(brief.context.notesPath !== undefined),
    );
  });

  const serve: ChannelBotSession["Service"]["serve"] = (initial, owner) =>
    gate
      .withPermits(1)(serveNow(initial, owner))
      .pipe(Effect.mapError(asLedgerError("serve")));

  const sendForTask = Effect.fn("ChannelBotSession.sendForTask")(function* (
    stored: ChannelLedger.ChannelStoredTask,
    threadId: ThreadId,
    text: string,
    ids: {
      readonly first: ReturnType<typeof turnSteerIdsFor>;
      readonly queued: ReturnType<typeof turnSteerIdsFor>;
    },
    attachments: ReadonlyArray<ChatAttachment>,
    forward: ReturnType<typeof sessionForwardDelivery>,
  ) {
    const task = stored.task;
    const projectId = ProjectId.make((yield* requireTarget(task)).projectId);
    const records = yield* readRecords(threads, threadId);
    const own = yield* sessionTaskRuns(sql, threadId, records, task);
    const current = ownResultRuns(own, records.messages).at(-1);
    const already = records.runs.find(
      (run) =>
        run.userMessageId === ids.first.messageId || run.userMessageId === ids.queued.messageId,
    );
    if (already !== undefined) {
      yield* recordRun(threadId, already.userMessageId as MessageId, already, false);
      return { _tag: "sent", run: already } as const;
    }
    const firstIntent = yield* sql<{ readonly steered_into_run_id: RunId | null }>`
      SELECT steered_into_run_id FROM channel_bot_session_runs
      WHERE thread_id = ${threadId} AND message_id = ${ids.first.messageId}
    `;
    const steeredInto = records.runs.find((run) => run.id === firstIntent[0]?.steered_into_run_id);
    if (steeredInto !== undefined) return { _tag: "sent", run: steeredInto } as const;
    const accepted = records.messages.find(
      (message) => message.id === ids.first.messageId || message.id === ids.queued.messageId,
    );
    if (accepted !== undefined) {
      const run = records.runs.find((candidate) => candidate.id === accepted.runId);
      if (run === undefined)
        return yield* new ChannelLedger.ChannelLedgerError({
          reason: "persistence",
          detail: "The accepted session message's run is unavailable.",
        });
      yield* recordRun(threadId, accepted.id, run, true);
      return { _tag: "sent", run } as const;
    }
    if (current?.status === "cancelled" && firstIntent.length === 0)
      return { _tag: "stopped", run: current } as const;
    const carriesNotes = yield* sessionCarriesNotes(sql, threadId).pipe(
      Effect.mapError(asLedgerError("session notes")),
    );
    const { sender, inputId } = forward;
    const live = SenderAuthority.requesterForDelivery(task, sender, inputId, carriesNotes).pipe(
      Effect.provideService(ChannelLedger.ChannelLedger, ledger),
      Effect.provideService(SlackChannelSettings.SlackChannelSettings, slackSettings),
    );
    const authority = yield* live;
    if (authority._tag !== "allowed")
      return {
        _tag: "permission_changed",
        senderName: authority._tag === "sender_changed" ? authority.name : undefined,
      } as const;
    const requester = authority.requester;
    const senderInput = sender?.inputId ?? inputId;
    const paused = yield* ledger.inputMemoryPaused(task.originInputId, senderInput);
    const memoryGrantCeiling = paused ? "none" : sessionMemoryCeiling(requester, task.target);
    const confirmation = yield* makeDispatchConfirmation(
      carriesNotes,
      live.pipe(
        Effect.map(
          (current) =>
            current._tag === "allowed" &&
            (paused || sessionMemoryCeiling(current.requester, task.target) === memoryGrantCeiling),
        ),
      ),
    );
    const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
    const attempt = (mode: "steer" | "queue", which: ReturnType<typeof turnSteerIdsFor>) =>
      writeIntent(threadId, which.messageId, task, "followup", forward.sequence, senderInput).pipe(
        Effect.andThen(
          threads
            .sendToThread({
              projectId,
              commandId: which.commandId,
              threadId,
              messageId: which.messageId,
              text,
              attachments,
              mode,
              ...confirmation.options,
              ...(mode === "steer" && current !== undefined ? { targetRunId: current.id } : {}),
              ...(memoryGrantCeiling === "none" ? {} : { memoryGrantCeiling }),
              createdBy: "user",
              creationSource: "server",
            })
            .pipe(modeLimit(requester, refused), Effect.result),
        ),
      );
    let which = ids.first;
    let sent = steersInto(current, firstIntent.length > 0, memoryGrantCeiling)
      ? yield* attempt("steer", ids.first)
      : undefined;
    if (
      sent === undefined ||
      (sent._tag === "Failure" &&
        rejected(sent.failure) &&
        !(yield* confirmation.refused) &&
        (yield* Ref.get(refused)) === undefined &&
        ids.queued.messageId !== ids.first.messageId)
    ) {
      which = ids.queued;
      sent = yield* attempt("queue", ids.queued);
    }
    if (sent._tag === "Failure") {
      if (yield* confirmation.refused)
        return { _tag: "permission_changed", senderName: sender?.requester.displayName } as const;
      return { _tag: "failed", failure: sent.failure, refusal: yield* Ref.get(refused) } as const;
    }
    yield* recordRun(
      threadId,
      which.messageId,
      sent.success.run,
      sent.success.delivery === "steered",
    );
    return { _tag: "sent", run: sent.success.run } as const;
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
    const idsFor = (attempt: "first" | "queued") =>
      event.payload.forwardKey === undefined
        ? turnSteerIdsFor(event.payload.inputId, attempt)
        : toolSteerIdsFor(event.payload.forwardKey, attempt);
    const ids = { first: idsFor("first"), queued: idsFor("queued") };
    const result = yield* sendForTask(
      stored,
      worker.threadId,
      sessionFollowUpText(event.payload),
      ids,
      event.payload.forwardKey === undefined ? yield* inputAttachments(event.payload.inputId) : [],
      sessionForwardDelivery(pending.sequence, event),
    );
    const own = [ids.first.messageId, ids.queued.messageId];
    if (result._tag === "permission_changed" && result.senderName !== undefined)
      return yield* SenderAuthority.refuseSenderFollowUp(ledger, stored, {
        eventId: event.eventId,
        name: result.senderName,
        owner,
        sequence: pending.sequence,
        own,
      });
    if (result._tag === "failed" || result._tag === "permission_changed") {
      if (result._tag === "failed" && result.refusal === undefined && !rejected(result.failure)) {
        yield* Effect.logWarning("GOAT Bot session follow-up failed; retrying", {
          taskId: event.taskId,
          cause: result.failure,
        });
        return;
      }
      yield* refuseForward(
        ledger,
        stored,
        result._tag === "permission_changed"
          ? "The requester’s permission changed; your follow-up was not sent. Open the thread in GOAT."
          : "The session didn't take your follow-up (\"" +
              event.payload.text +
              '"). Say it again, or open the thread in GOAT.',
        owner,
        pending.sequence,
        own,
      );
      return;
    }
    // A stopped run is not restarted: the follow-up is dropped and its fence lifted.
    if (yield* bindAfterSend(ledger, event.taskId, own, result.run, owner)) yield* done;
  });

  const forwardAnswer = Effect.fn("ChannelBotSession.forwardAnswer")(function* (
    pending: ChannelLedger.ChannelPendingEvent,
    owner: string,
  ) {
    const event = pending.event;
    const done = ledger.completeForward({
      owner,
      sequence: pending.sequence,
      clearPendingAnswerMessageId: answerForwardIdsFor(event.eventId).messageId,
    });
    const stored = yield* ledger.getTask(event.taskId);
    if (
      event.type !== "task.question.answered" ||
      stored?.task.worker === undefined ||
      (stored.task.status !== "running" && stored.task.status !== "waiting_input")
    )
      return yield* done;
    const ids = answerForwardIdsFor(event.eventId);
    const result = yield* sendForTask(
      stored,
      stored.task.worker.threadId,
      "Answer from " + stored.task.requester.displayName + ": " + event.payload.answer,
      { first: ids, queued: ids },
      [],
      sessionForwardDelivery(pending.sequence, event),
    );
    if (result._tag === "failed" || result._tag === "permission_changed") {
      if (result._tag === "failed" && result.refusal === undefined && !rejected(result.failure))
        return;
      yield* refuseForward(
        ledger,
        stored,
        result._tag !== "permission_changed"
          ? "The session didn't take your answer (\"" +
              event.payload.answer +
              '"). Answer again, or answer in the thread.'
          : result.senderName === undefined
            ? "The requester’s permission changed; your answer was not sent. Open the thread in GOAT."
            : SenderAuthority.senderAnswerRefused(result.senderName),
        owner,
        pending.sequence,
        [ids.messageId],
      );
      return;
    }
    if (yield* bindAfterSend(ledger, event.taskId, [ids.messageId], result.run, owner)) yield* done;
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
      if (!(yield* ledger.isForwardPending(pending.sequence))) return true;
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

export const layer = Layer.effect(ChannelBotSession, make).pipe(Layer.provide(Profiles.layer));
