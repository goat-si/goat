/**
 * ChannelReceptionService - reads one channel input and answers it right away.
 *
 * Each input gets its own pass with its own reception id; nothing waits on another input or on
 * a provider session. The model (a tool-free one-shot text generation) proposes a reply and an
 * action; this service checks the action against the ledger and the requester's permissions,
 * then commits the reply, any new task, and their deliveries in one transaction.
 *
 * The same service words task updates for the requester (`narrate`) when the ledger records a
 * result, failure, or question.
 *
 * @module ChannelReceptionService
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- reception ids only need a random UUID.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import {
  CHANNEL_HOST_WORKSPACE_LABEL,
  type ChannelInboundMessage,
  type ChannelInputId,
  type ChannelConversationId,
  type ChannelReceptionHostFact,
  type ChannelReceptionInput,
  type ChannelReceptionRead,
  type ChannelReceptionReadResult,
  type ChannelReceptionResult,
  type ChannelReplyAddress,
  type ChannelRequester,
  type ChannelTask,
  type ChannelTaskApprovalRef,
  type ChannelTaskNeedsYou,
  ChannelReceptionId,
  CommandId,
  CHANNEL_RECEPTION_TAIL_LIMITS,
  type ChannelOutboundKind,
  type OrchestrationV2ThreadShell,
} from "@goat/contracts";
import {
  channelEvidenceLabels,
  channelEvidenceSentence,
  splitChannelResultText,
} from "@goat/shared/channelEvidence";
import * as HostProcess from "@goat/shared/HostProcess";
import {
  classifyTextGenerationFailure,
  type TextGenerationFailureKind,
} from "@goat/provider-core/server/textGenerationUtils";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { countHostThreads } from "../mcp/hostStatusModel.ts";
import * as MemoryAccess from "../memory/MemoryAccess.ts";
import * as MemoryService from "../memory/MemoryService.ts";
import * as MemorySyncService from "../memory/MemorySyncService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ChannelBotTimeline from "./ChannelBotTimeline.ts";
import { lowerRuntimeMode, mayAnswerFor } from "./ChannelGateway.ts";
import * as ChannelBotHome from "./ChannelBotHome.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRemoteWorkers from "./ChannelRemoteWorkers.ts";
import { makeChannelProjectChoices } from "./channelProjectChoices.ts";
import * as ChannelWake from "./ChannelWake.ts";
import {
  appendChannelBotNote,
  channelBotFilesFor,
  listChannelBotSkills,
  quotedFromInput,
  readChannelBotNotes,
} from "./channelBotNotes.ts";
import {
  boundRecall,
  canSeeTask,
  journalFor,
  matchMemoryLines,
  matchTasks,
  pullRequestLabel,
  RECALL_MEMORY_LINES,
  RECALL_RESULT_CHARS,
  RECALL_TASK_SCAN,
  RECALL_THREAD_RUNS,
  taskDigest,
  threadDigest,
} from "./channelBotRecall.ts";
import { CHANNEL_COPY } from "./channelCopy.ts";
import {
  approvalCard,
  approvalChoiceLabels,
  type ApprovalReply,
  type OpenApprovalCard,
  openApprovalCards,
  parseApprovalReply,
  whichApproval,
} from "./channelApprovalCards.ts";
import {
  approvalCodeOrder,
  choiceAt,
  latestDeliveredChoices,
  numberedChoiceLines,
  parseNumberedReply,
  singleQuestionChoice,
  type DeliveredChoices,
} from "./channelDecisionChoices.ts";
import { openQuestionTask } from "./channelQuestionAnswers.ts";
import { isOpenItem, pendingDigest, workItemState } from "./channelWorkQueue.ts";
import { WORKERS_PER_REQUESTER } from "./ChannelDispatcher.ts";
import {
  answerForwardIdsFor,
  deliveryIdFor,
  taskEventIdFor,
  taskIdFor,
  turnSteerIdsFor,
} from "./channelIds.ts";
import { botAddress, chipDelivery, makeTaskEvent, prepareTransition } from "./channelTaskWrites.ts";

const movedNarration = (payload: { fromHost: string; host: string; replicaCapturedAt: string }) =>
  `${payload.fromHost} stopped answering, so this continues on ${payload.host} from the copy of its work taken at ${payload.replicaCapturedAt}. Whatever it does on ${payload.fromHost} after that stays there.`;

/** How long a reception pass may take before the sender gets a failure note instead. */
const CHANNEL_RECEPTION_TIMEOUT_MS = 45_000;

type ReceptionOutcome =
  | { readonly ok: true; readonly result: ChannelReceptionResult }
  | { readonly ok: false; readonly failure: TextGenerationFailureKind };
const receptionFailure = (failure: TextGenerationFailureKind): ReceptionOutcome => ({
  ok: false,
  failure,
});
/** How many recently active threads a reception pass sees by title. */
const CHANNEL_RECEPTION_RECENT_THREADS = 20;
/** How long one read may take before the answer says so and goes on without it. */
const CHANNEL_READ_TIMEOUT_MS = 5_000;

const GIB = 1024 ** 3;
const gib = (bytes: number) => (bytes / GIB).toFixed(bytes < 10 * GIB ? 1 : 0) + " GB";

/** macOS reports a Darwin kernel release; its major number maps to the macOS version. */
const macOsVersion = (release: string) => {
  const major = Number.parseInt(release, 10);
  if (!Number.isFinite(major) || major < 20) return "macOS (Darwin " + release + ")";
  return "macOS " + (major >= 25 ? major + 1 : major - 9) + " (Darwin " + release + ")";
};

const duration = (seconds: number) => {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return days + "d " + hours + "h";
  return hours > 0 ? hours + "h " + minutes + "m" : minutes + "m";
};

export class ChannelReceptionService extends Context.Service<
  ChannelReceptionService,
  {
    /** Answers one input. Does nothing when the input already finished or another pass owns it. */
    readonly receive: (
      inputId: ChannelInputId,
      owner: string,
    ) => Effect.Effect<void, ChannelLedger.ChannelLedgerError>;
    /** Words one task update for the requester and commits its deliveries. */
    readonly narrate: (
      pending: ChannelLedger.ChannelPendingEvent,
      owner: string,
    ) => Effect.Effect<void, ChannelLedger.ChannelLedgerError>;
  }
>()("goat/channels/ChannelReceptionService") {}

const replyDelivery = (input: {
  readonly causeKey: string;
  readonly destination: ChannelReplyAddress;
  readonly kind: ChannelOutboundKind;
  readonly text: string;
  readonly inputId?: ChannelInputId | undefined;
  readonly task?: ChannelTask | undefined;
  readonly mentionActorId?: string | undefined;
  readonly options?: ReadonlyArray<string> | undefined;
}): ChannelLedger.ChannelOutboxInsert => {
  const deliveryId = deliveryIdFor(input.causeKey);
  const options = input.options === undefined || input.options.length === 0 ? [] : input.options;
  // The GOAT app shows choices as buttons. Slack keeps the labels for Block Kit buttons and
  // also lists them, so a notification or a typed number still works. iMessage and the rest
  // get the numbered list only.
  const buttons = input.destination.kind === "goat" && options.length > 0;
  const listed = !buttons && options.length > 0;
  const text = listed ? input.text + "\n" + numberedChoiceLines(options) : input.text;
  const keepOptions = buttons || (input.destination.kind === "slack" && options.length > 0);
  return {
    deliveryId,
    causeKey: input.causeKey,
    ...(input.inputId === undefined ? {} : { inputId: input.inputId }),
    ...(input.task === undefined ? {} : { taskId: input.task.taskId }),
    message: {
      deliveryId,
      destination: input.destination,
      kind: input.kind,
      text,
      ...(input.inputId === undefined ? {} : { inReplyToInputId: input.inputId }),
      ...(input.task === undefined
        ? {}
        : { taskId: input.task.taskId, taskVersion: input.task.version }),
      ...(input.mentionActorId === undefined ? {} : { mentionActorId: input.mentionActorId }),
      ...(keepOptions ? { options } : {}),
    },
  };
};

/** Slack replies tag the person; the GOAT bot and MCP do not. */
const mentionFor = (address: ChannelReplyAddress, externalActorId: string | undefined) =>
  address.kind === "slack" ? externalActorId : undefined;

/** Keeps the newest tail entries that fit the byte budget. */
const boundTail = (
  entries: ReadonlyArray<ChannelReceptionInput["tail"][number]>,
): ChannelReceptionInput["tail"] => {
  const kept: Array<ChannelReceptionInput["tail"][number]> = [];
  let bytes = 0;
  for (const entry of entries.toReversed()) {
    bytes += entry.text.length;
    if (bytes > CHANNEL_RECEPTION_TAIL_LIMITS.bytes) break;
    kept.unshift(entry);
  }
  return kept;
};

/**
 * The GOAT Bot turn a follow-up in this conversation steers: the newest turn whose coding thread
 * is running here. Messages in other conversations, or when no turn runs, start their own.
 */
const turnToSteer = (tasks: ReadonlyArray<ChannelTask>): ChannelTask | undefined =>
  tasks
    .filter(
      (task) =>
        task.kind === "turn" &&
        task.status === "running" &&
        task.worker !== undefined &&
        task.worker.host === undefined &&
        task.target !== undefined,
    )
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0];

const make = Effect.gen(function* () {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const home = yield* ChannelBotHome.ChannelBotHome;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const timeline = yield* ChannelBotTimeline.ChannelBotTimeline;
  const wake = yield* ChannelWake.ChannelWake;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const remoteWorkers = yield* ChannelRemoteWorkers.ChannelRemoteWorkers;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const ssh = yield* SshRemoteDispatch.SshRemoteDispatch;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const botFiles = channelBotFilesFor(path, serverConfig.stateDir);
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  // Absent in embeddings without memory; the bot then reads only its notes and the ledger.
  const memoryService = yield* Effect.serviceOption(MemoryService.MemoryService);
  const memorySync = yield* Effect.serviceOption(MemorySyncService.MemorySyncService);

  // Facts that do not change while the server runs.
  const linuxName =
    platform === "linux"
      ? yield* fileSystem.readFileString("/etc/os-release").pipe(
          Effect.map((text) => /^PRETTY_NAME="?([^"\n]+)"?/mu.exec(text)?.[1]),
          Effect.orElseSucceed(() => undefined),
        )
      : undefined;
  const osName =
    platform === "darwin"
      ? macOsVersion(NodeOS.release())
      : platform === "win32"
        ? NodeOS.version()
        : (linuxName ?? NodeOS.type()) + " (kernel " + NodeOS.release() + ")";
  const cpus = NodeOS.cpus();
  const cpu = (cpus[0]?.model.trim() || "unknown CPU") + ", " + cpus.length + " cores";

  /** What reception knows about this machine, read fresh for each message. */
  const hostFacts = (
    shells: ReadonlyArray<OrchestrationV2ThreadShell>,
  ): Effect.Effect<ReadonlyArray<ChannelReceptionHostFact>> =>
    Effect.gen(function* () {
      const descriptor = yield* environment.getDescriptor;
      const hostname = NodeOS.hostname();
      const now = DateTime.toDateUtc(yield* DateTime.now);
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const counts = countHostThreads(shells);
      const facts: Array<ChannelReceptionHostFact> = [
        {
          label: "Machine",
          value:
            descriptor.label === hostname
              ? hostname
              : descriptor.label + " (hostname " + hostname + ")",
        },
        { label: "Operating system", value: osName },
        { label: "Architecture", value: architecture },
        { label: "CPU", value: cpu },
        {
          label: "Memory",
          value: gib(NodeOS.totalmem()) + " total, " + gib(NodeOS.freemem()) + " free",
        },
        { label: "Up for", value: duration(NodeOS.uptime()) },
        { label: "GOAT version", value: packageJson.version },
        {
          label: "Local time",
          value:
            now.toLocaleString("en-US", { timeZone, dateStyle: "full", timeStyle: "short" }) +
            " (" +
            timeZone +
            ")",
        },
        {
          label: "Threads",
          value:
            counts.running +
            " running, " +
            counts.waiting +
            " waiting on a person, " +
            counts.queued +
            " queued",
        },
      ];
      return facts;
    }).pipe(Effect.orElseSucceed(() => []));

  /** Every project, with the bot's own workspace offered as the place for host-level work. */
  const allowedTargets = (botProjectId: string | undefined) =>
    Effect.gen(function* () {
      const shells = yield* projects.listShells().pipe(Effect.orElseSucceed(() => []));
      return shells.map((shell) => ({
        projectId: shell.id,
        label: shell.id === botProjectId ? CHANNEL_HOST_WORKSPACE_LABEL : shell.title,
      }));
    });

  const projectChoices = (yield* makeChannelProjectChoices).question;

  const listThreads = threads
    .listProjectThreads({ projectId: undefined, includeSubagents: false })
    .pipe(Effect.orElseSucceed((): ReadonlyArray<OrchestrationV2ThreadShell> => []));

  /** Newest first, leaving out the bot's own thread. Titles only; contents stay private. */
  const recentThreads = (
    shells: ReadonlyArray<OrchestrationV2ThreadShell>,
    targets: ReadonlyArray<{ readonly projectId: string; readonly label: string }>,
    botThreadId: string | undefined,
  ) => {
    const labels = new Map(targets.map((target) => [target.projectId, target.label]));
    return shells
      .filter(
        (shell) =>
          shell.id !== botThreadId && shell.archivedAt === null && shell.title.trim() !== "",
      )
      .slice(0, CHANNEL_RECEPTION_RECENT_THREADS)
      .map((shell) => {
        const project = labels.get(shell.projectId)?.trim();
        return {
          title: shell.title.trim(),
          ...(project ? { project } : {}),
          working: shell.activeRunId !== null,
        };
      });
  };

  const generateOutcome = (input: ChannelReceptionInput) =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings.pipe(Effect.option);
      const generateReception = textGeneration.generateChannelReception;
      if (Option.isNone(settings) || generateReception === undefined) {
        yield* Effect.logWarning("channel reception failed", { kind: "unavailable" });
        return receptionFailure("unavailable");
      }
      return yield* generateReception({
        cwd: serverConfig.stateDir,
        input,
        modelSelection: settings.value.textGenerationModelSelection,
      }).pipe(
        Effect.timeoutOption(CHANNEL_RECEPTION_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.logWarning("channel reception failed", { kind: "timeout" }).pipe(
                Effect.as(receptionFailure("timeout")),
              ),
            onSome: (result): Effect.Effect<ReceptionOutcome> =>
              Effect.succeed({ ok: true, result }),
          }),
        ),
        Effect.catch((cause) => {
          const kind = classifyTextGenerationFailure(cause);
          return Effect.logWarning("channel reception failed", { kind, cause }).pipe(
            Effect.as(receptionFailure(kind)),
          );
        }),
      );
    });
  // Narration falls back to the worker's own words when the model cannot phrase them.
  const generate = (input: ChannelReceptionInput) =>
    generateOutcome(input).pipe(
      Effect.map((outcome) => (outcome.ok ? Option.some(outcome.result) : Option.none())),
    );

  /**
   * Every open task this requester may see, however old: unfinished ones, finished ones whose
   * outcome has not reached the person, and the newest visible ones.
   */
  const openAndRecentTasks = (viewer: ChannelRequester, conversationId: ChannelConversationId) =>
    Effect.gen(function* () {
      const open = (yield* ledger.listTasksByStatus([
        "received",
        "dispatching",
        "running",
        "waiting_input",
      ]))
        .map((stored) => stored.task)
        .filter((task) => canSeeTask(viewer, task, conversationId));
      const undelivered = (yield* ledger.listUndeliveredOutcomes(viewer.ownerId)).filter((task) =>
        canSeeTask(viewer, task, conversationId),
      );
      const recent = yield* visibleTasks(viewer, conversationId);
      const all = [...open, ...undelivered, ...recent];
      const seen = new Set<string>();
      return all.filter((task) => {
        if (seen.has(task.taskId)) return false;
        seen.add(task.taskId);
        return true;
      });
    });

  /** The owner's newest tasks this requester may see. */
  const visibleTasks = (viewer: ChannelRequester, conversationId: ChannelConversationId) =>
    ledger
      .listTasks({ ownerId: viewer.ownerId, limit: RECALL_TASK_SCAN })
      .pipe(
        Effect.map((page) => page.tasks.filter((task) => canSeeTask(viewer, task, conversationId))),
      );

  /**
   * The scopes a requester holds now. A Slack or iMessage link is read again, so a link removed
   * or narrowed since the message arrived counts; an in-app requester keeps the scopes its
   * session had. Agents over MCP read GOAT memory with their own memory tools, not through the bot.
   */
  const scopesNow = (viewer: ChannelRequester, connectionId: string) =>
    Effect.gen(function* () {
      if (viewer.originKind === "mcp") return [];
      if (viewer.originKind !== "slack" && viewer.originKind !== "imessage") {
        return viewer.grantedScopes;
      }
      if (viewer.externalActorId === undefined) return [];
      const linked = yield* ledger.findIdentity({
        connectionId,
        externalActorId: viewer.externalActorId,
      });
      return linked === undefined || linked.principalId !== viewer.principalId
        ? []
        : viewer.grantedScopes.filter((scope) => linked.grantedScopes.includes(scope));
    });

  /**
   * The requester as reads judge them now. A Slack or iMessage link removed or moved to another
   * person since the message arrived leaves only this conversation's work visible.
   */
  const viewerNow = (requester: ChannelRequester, connectionId: string) =>
    Effect.gen(function* () {
      const scopes = yield* scopesNow(requester, connectionId).pipe(
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
      );
      const external = requester.originKind === "slack" || requester.originKind === "imessage";
      const linkedNow =
        !external ||
        (requester.externalActorId !== undefined &&
          (yield* ledger
            .findIdentity({ connectionId, externalActorId: requester.externalActorId })
            .pipe(Effect.orElseSucceed(() => undefined)))?.principalId === requester.principalId);
      return {
        ...requester,
        grantedScopes: requester.grantedScopes.filter((scope) => scopes.includes(scope)),
        ...(linkedNow ? {} : { principalId: "unlinked:" + (requester.externalActorId ?? "") }),
      } satisfies ChannelRequester;
    });

  /**
   * GOAT memory items for a query, under the requester's memory access as it stands now. Empty
   * when memory is off, not set up, or the requester may not read it.
   */
  const searchGoatMemory = (viewer: ChannelRequester, connectionId: string, query: string) =>
    Effect.gen(function* () {
      if (Option.isNone(memoryService) || Option.isNone(memorySync)) return [];
      const live = scopesNow(viewer, connectionId);
      if (!(yield* live).includes("memory:read")) return [];
      const settings = yield* serverSettings.getSettings;
      if (!settings.memoryEnabled) return [];
      const readiness = yield* memorySync.value.readLocalReadiness();
      if (readiness.bootstrap !== "ready" || readiness.memorySpaceId === null) return [];
      const page = yield* memoryService.value.search(
        {
          memorySpaceId: readiness.memorySpaceId,
          query: query.trim().normalize("NFC"),
          limit: RECALL_MEMORY_LINES,
          mode: "fts",
        },
        MemoryAccess.memoryAccessPermit(
          {
            grantedScopes: viewer.grantedScopes,
            // Each permit check reads the link again and fails when it no longer allows reading.
            reauthorize: (required) =>
              live.pipe(
                Effect.orElseSucceed((): ReadonlyArray<string> => []),
                Effect.flatMap((scopes) =>
                  required.every((scope) => scopes.includes(scope))
                    ? Effect.void
                    : Effect.fail(new MemoryService.MemoryAccessError({ code: "unavailable" })),
                ),
              ),
            readOnly: true,
          },
          "read",
        ),
      );
      return page.items.flatMap((item) =>
        item.status === "active" ? ["- " + item.payload.text.replace(/\s+/gu, " ").trim()] : [],
      );
    }).pipe(
      Effect.catch((cause) =>
        Effect.logInfo("GOAT Bot memory search skipped", { cause }).pipe(Effect.as([])),
      ),
    );

  const runRead = (
    read: ChannelReceptionRead,
    viewer: ChannelRequester,
    conversationId: ChannelConversationId,
    connectionId: string,
    inputId: ChannelInputId,
  ) =>
    Effect.gen(function* () {
      switch (read.kind) {
        case "memory": {
          const notes = yield* readChannelBotNotes(fileSystem, botFiles);
          // The whole visible journal is searched; only the prompt's copy is cut to size.
          const journal = journalFor(
            yield* visibleTasks(viewer, conversationId),
            RECALL_TASK_SCAN,
            Number.POSITIVE_INFINITY,
          );
          // Oldest first, as the notes are, so the newest matches survive the limit.
          const local = matchMemoryLines(
            notes + "\n" + journal.split("\n").toReversed().join("\n"),
            read.query,
          );
          const goat = yield* searchGoatMemory(viewer, connectionId, read.query);
          if (local.length === 0 && goat.length === 0) return "Nothing in memory matches.";
          return [
            ...(local.length === 0 ? [] : ["GOAT Bot notes and journal:", ...local]),
            ...(goat.length === 0 ? [] : ["GOAT memory:", ...goat]),
          ].join("\n");
        }
        case "work": {
          const matched = matchTasks(yield* visibleTasks(viewer, conversationId), read.query);
          return matched.length === 0
            ? "No work this person may see matches."
            : matched.map(taskDigest).join("\n\n");
        }
        case "thread": {
          const task = matchTasks(yield* visibleTasks(viewer, conversationId), read.query, 1)[0];
          if (task === undefined) return "No work this person may see matches.";
          const worker = task.worker;
          if (worker === undefined) {
            return taskDigest(task) + "\nIts coding thread has not started.";
          }
          if (worker.host !== undefined) {
            // Remote threads are read through their reports, which the ledger already holds.
            return (
              taskDigest(task) +
              "\nIts thread runs on " +
              worker.host +
              "; only its reports reach this machine."
            );
          }
          // Only the newest runs' messages are loaded; a long thread is never read whole.
          const { runs } = yield* threads.getThreadRecords(worker.threadId, ["runs"]);
          const recentRuns = runs.slice(-RECALL_THREAD_RUNS).map((run) => run.id);
          const records = yield* threads.getThreadRecords(worker.threadId, ["messages"], {
            messageRunIds: recentRuns,
          });
          const digest = taskDigest(task);
          return (
            digest +
            "\n" +
            threadDigest(
              records.thread.title || task.title,
              records.messages.map((message) => ({
                role: message.role,
                text: message.text,
                createdAt: DateTime.formatIso(message.createdAt),
              })),
              RECALL_RESULT_CHARS - digest.length - 1,
            )
          );
        }
        case "pending": {
          const visible = yield* openAndRecentTasks(viewer, conversationId);
          const deliveries = yield* ledger.outcomeDeliveries(visible.map((task) => task.taskId));
          const items = visible.map((task) => ({
            task,
            state: workItemState(task, deliveries.get(task.taskId)),
          }));
          const open = items.filter((item) => isOpenItem(item.state));
          const runs = yield* ledger.listWorkerRuns(open.map((item) => item.task.taskId));
          const busy = new Map<string, number>();
          for (const item of open) {
            const key = item.task.requester.ownerId + "\u0000" + item.task.requester.principalId;
            if (!busy.has(key)) {
              busy.set(
                key,
                yield* ledger.countBusyTasks({
                  ownerId: item.task.requester.ownerId,
                  principalId: item.task.requester.principalId,
                }),
              );
            }
          }
          return pendingDigest(
            open.map((item) => ({
              ...item,
              runs: runs.filter((run) => run.taskId === item.task.taskId),
              ...(item.state === "queued" &&
              (busy.get(item.task.requester.ownerId + "\u0000" + item.task.requester.principalId) ??
                0) >= WORKERS_PER_REQUESTER
                ? {
                    note:
                      "waiting for one of the " +
                      WORKERS_PER_REQUESTER +
                      " running for " +
                      item.task.requester.displayName +
                      " to finish",
                  }
                : {}),
            })),
            DateTime.toEpochMillis(yield* DateTime.now),
          );
        }
        case "conversation": {
          const found = yield* ledger.searchConversation(conversationId, read.query, 5, inputId);
          return found.length === 0
            ? "No earlier message in this conversation matches."
            : found
                .map(
                  (entry) =>
                    "- " +
                    entry.receivedAt.slice(0, 16) +
                    " Person: " +
                    entry.text +
                    (entry.replyText === undefined ? "" : "\n  GOAT: " + entry.replyText),
                )
                .join("\n");
        }
      }
    });

  /** Runs one pass's reads. A read that fails says so instead of failing the reply. */
  const runReads = (
    reads: ReadonlyArray<ChannelReceptionRead>,
    viewer: ChannelRequester,
    conversationId: ChannelConversationId,
    connectionId: string,
    inputId: ChannelInputId,
  ): Effect.Effect<ReadonlyArray<ChannelReceptionReadResult>> =>
    Effect.forEach(
      reads,
      (read) =>
        runRead(read, viewer, conversationId, connectionId, inputId).pipe(
          Effect.timeoutOption(CHANNEL_READ_TIMEOUT_MS),
          Effect.map((text) => ({
            kind: read.kind,
            query: read.query,
            text: Option.match(text, {
              onNone: () => "(took too long to read)",
              onSome: boundRecall,
            }),
          })),
          Effect.catch((cause) =>
            Effect.logWarning("GOAT Bot read failed", { kind: read.kind, cause }).pipe(
              Effect.as({ kind: read.kind, query: read.query, text: "(could not be read)" }),
            ),
          ),
        ),
      { concurrency: "unbounded" },
    );

  /** What an approval asks for, read from its thread's newest runs; missing words are fine. */
  const approvalDetail = (approval: ChannelTaskApprovalRef) =>
    Effect.gen(function* () {
      const { runs } = yield* threads.getThreadRecords(approval.threadId, ["runs"]);
      const records = yield* threads.getThreadRecords(
        approval.threadId,
        ["runtimeRequests", "turnItems"],
        { turnItemRunIds: runs.slice(-2).map((run) => run.id) },
      );
      const item = records.turnItems.find(
        (entry) => entry.type === "approval_request" && entry.requestId === approval.requestId,
      );
      return {
        kind: records.runtimeRequests.find((request) => request.id === approval.requestId)?.kind,
        prompt: item?.type === "approval_request" ? item.prompt : undefined,
      };
    }).pipe(
      Effect.timeoutOption(CHANNEL_READ_TIMEOUT_MS),
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );

  /** Same words a local answer records, and the provenance a remote respond requires. */
  const approvalReason = (
    decision: ApprovalReply["decision"],
    answerer: ChannelRequester,
    via: ChannelRequester["originKind"],
  ) =>
    (decision === "accept" ? "Approved" : "Denied") +
    " by " +
    answerer.displayName +
    " from GOAT Bot (" +
    via +
    ").";

  const approvalSent = (decision: ApprovalReply["decision"], title: string) =>
    decision === "accept"
      ? "Approved. " + title + " continues."
      : "Denied. I told the agent on " + title + " not to.";

  /**
   * Answers one approval for a person allowed to answer for the work's requester. A local answer's
   * command id comes from the input, so a reception that runs again after a restart cannot answer
   * twice. An approval held on another machine is sent there; that request resolves once.
   */
  const answerApproval = (
    card: OpenApprovalCard,
    decision: ApprovalReply["decision"],
    answerer: ChannelRequester | undefined,
    inputId: ChannelInputId,
    via: ChannelRequester["originKind"],
  ) =>
    Effect.gen(function* () {
      if (answerer === undefined || !mayAnswerFor(answerer, card.task.requester)) {
        return CHANNEL_COPY.approvalNotAllowed;
      }
      const host = card.approval.host;
      if (host !== undefined) {
        const reason = approvalReason(decision, answerer, via);
        const sent = yield* ssh
          .callHostTool(
            {
              host,
              tool: "goat_pending_request_respond",
              arguments: {
                threadId: card.approval.threadId,
                requestId: card.approval.requestId,
                decision,
                reason,
              },
              writes: true,
              approvals: true,
              timeoutMs: 90_000,
            },
            // The answerer's own ceiling. mayAnswerFor already requires it to cover the requester,
            // and the remote session never falls back to a narrower one.
            Effect.succeed(answerer.runtimeModeCeiling),
          )
          .pipe(
            Effect.as("sent" as const),
            Effect.catch((cause) =>
              Effect.logWarning("GOAT Bot approval not answered", { cause }).pipe(
                Effect.as(
                  cause instanceof SshRemoteDispatch.SshRemoteDispatchError &&
                    cause.message.includes("answer approvals")
                    ? ("refused" as const)
                    : ("failed" as const),
                ),
              ),
            ),
          );
        if (sent === "refused") return CHANNEL_COPY.approvalRemoteRefused;
        return sent === "sent"
          ? approvalSent(decision, card.task.title)
          : CHANNEL_COPY.approvalFailed;
      }
      const sent = yield* threads
        .dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make("channel-approval:" + inputId),
          threadId: card.approval.threadId,
          requestId: card.approval.requestId,
          decision,
          respondedBy: {
            type: "client",
            label: "GOAT Bot",
            reason: approvalReason(decision, answerer, via),
          },
        })
        .pipe(
          Effect.as(true),
          Effect.catch((cause) =>
            Effect.logWarning("GOAT Bot approval not answered", { cause }).pipe(Effect.as(false)),
          ),
        );
      if (sent) return approvalSent(decision, card.task.title);
      const pending = yield* threads
        .getThreadRecords(card.approval.threadId, ["runtimeRequests"])
        .pipe(
          Effect.map((records) =>
            records.runtimeRequests.some(
              (request) => request.id === card.approval.requestId && request.status === "pending",
            ),
          ),
          Effect.orElseSucceed(() => true),
        );
      return pending ? CHANNEL_COPY.approvalFailed : CHANNEL_COPY.approvalAlreadyAnswered;
    });

  /** One card per approval the observation lists; a card already sent is not sent again. */
  const approvalCards = (task: ChannelTask, listed: ReadonlyArray<ChannelTaskNeedsYou>) =>
    Effect.gen(function* () {
      const wanted = new Set(listed.flatMap((need) => need.approval?.requestId ?? []));
      const deliveries: Array<ChannelLedger.ChannelOutboxInsert> = [];
      for (const card of openApprovalCards([task])) {
        if (!wanted.has(card.approval.requestId)) continue;
        const detail = yield* approvalDetail(card.approval);
        const code = yield* ledger.issueApprovalCode({
          conversationId: task.conversationId,
          requestId: card.approval.requestId,
          now: DateTime.formatIso(yield* DateTime.now),
        });
        const words = approvalCard({
          card,
          code,
          bySubagent: card.approval.threadId !== task.worker?.threadId,
          kind: detail?.kind,
          prompt: detail?.prompt,
        });
        deliveries.push(
          replyDelivery({
            causeKey: "approval:" + card.approval.requestId,
            destination: task.originAddress,
            kind: "question",
            text: words.text,
            task,
            mentionActorId: mentionFor(task.originAddress, task.requester.externalActorId),
            options: words.options,
          }),
        );
      }
      return deliveries;
    });

  /**
   * The ledger card can lag the thread: someone may have answered in the thread before this pass
   * rewrote the observation. A local request that is no longer pending is not an open card. A
   * remote request stays listed; this machine cannot see its status. A read failure stays listed
   * so the answer path can say it could not be passed on.
   */
  const approvalStillPending = (card: OpenApprovalCard) =>
    card.approval.host !== undefined
      ? Effect.succeed(true)
      : threads.getThreadRecords(card.approval.threadId, ["runtimeRequests"]).pipe(
          Effect.map((records) =>
            records.runtimeRequests.some(
              (request) => request.id === card.approval.requestId && request.status === "pending",
            ),
          ),
          Effect.orElseSucceed(() => true),
        );

  /**
   * What an approve or deny reply does: a bare verb answers the only open card (or asks which of
   * several); a code answers the request it was issued for, or says it was already answered.
   * Undefined means the message was not about a card and goes to the model as usual.
   */
  const decideApprovalReply = (
    reply: ApprovalReply,
    conversationId: ChannelConversationId,
    inputId: ChannelInputId,
    answerer: Effect.Effect<ChannelRequester | undefined, ChannelLedger.ChannelLedgerError>,
    via: ChannelRequester["originKind"],
  ) =>
    Effect.gen(function* () {
      const listed = openApprovalCards(yield* ledger.listConversationNeedsYou(conversationId));
      const open: Array<OpenApprovalCard> = [];
      for (const card of listed) {
        if (yield* approvalStillPending(card)) open.push(card);
      }
      const answer = (card: OpenApprovalCard) =>
        Effect.gen(function* () {
          return {
            text: yield* answerApproval(card, reply.decision, yield* answerer, inputId, via),
            options: undefined,
            task: card.task,
          };
        });
      if (reply.code === undefined) {
        if (open.length === 0) return undefined;
        if (open.length === 1) return yield* answer(open[0]!);
        const now = DateTime.formatIso(yield* DateTime.now);
        const coded = yield* Effect.forEach(open, (card) =>
          ledger
            .issueApprovalCode({ conversationId, requestId: card.approval.requestId, now })
            .pipe(Effect.map((code) => ({ card, code }))),
        );
        return { ...whichApproval(coded, reply.decision), task: undefined };
      }
      const requestId = yield* ledger.approvalRequestForCode({ conversationId, code: reply.code });
      if (requestId === undefined) return undefined;
      const card = open.find((candidate) => candidate.approval.requestId === requestId);
      return card === undefined
        ? { text: CHANNEL_COPY.approvalAlreadyAnswered, options: undefined, task: undefined }
        : yield* answer(card);
    });

  /**
   * The numbered list a Slack or iMessage reply of "2" refers to: the latest open approval
   * card or question in this conversation. Cards that were never sent have no code and are
   * skipped. Questions come from the recent tasks plus any older task still needing a person.
   */
  const deliveredChoices = (
    conversationId: ChannelConversationId,
    tasks: ReadonlyArray<ChannelTask>,
  ) =>
    Effect.gen(function* () {
      const needing = yield* ledger.listConversationNeedsYou(conversationId);
      const seen = new Set(tasks.map((task) => task.taskId));
      const questions = [...tasks, ...needing.filter((task) => !seen.has(task.taskId))].flatMap(
        (task) =>
          task.openQuestions.flatMap((question): ReadonlyArray<DeliveredChoices> =>
            question.options === undefined || question.options.length === 0
              ? []
              : [
                  {
                    at: question.askedAt,
                    tie: 0,
                    options: question.options,
                    target: {
                      type: "question",
                      taskId: task.taskId,
                      questionId: question.questionId,
                    },
                  },
                ],
          ),
      );
      const coded = yield* Effect.forEach(openApprovalCards(needing), (card) =>
        ledger.approvalCodeForRequest(card.approval.requestId).pipe(
          Effect.map((found): DeliveredChoices | undefined =>
            found === undefined
              ? undefined
              : {
                  at: found.issuedAt,
                  tie: approvalCodeOrder(found.code),
                  options: approvalChoiceLabels(found.code),
                  target: { type: "approval" },
                },
          ),
        ),
      );
      return latestDeliveredChoices([
        ...questions,
        ...coded.flatMap((entry) => (entry === undefined ? [] : [entry])),
      ]);
    });

  /**
   * A choice answered before the model runs. A number on Slack or iMessage selects the latest
   * open list. A label equal to the only open question's option answers that question. An
   * approval word is left for the approval parser, which already checks who may answer.
   */
  const inboundChoice = (
    message: ChannelInboundMessage,
    conversationId: ChannelConversationId,
    tasks: ReadonlyArray<ChannelTask>,
  ) =>
    Effect.gen(function* () {
      if (message.intent !== "message" || message.kind === "mcp") return undefined;
      if (message.kind === "slack" || message.kind === "imessage") {
        const number = parseNumberedReply(message.text);
        if (number !== undefined) {
          const choices = yield* deliveredChoices(conversationId, tasks);
          const label = choices === undefined ? undefined : choiceAt(choices, number);
          if (choices !== undefined && label !== undefined) {
            return choices.target.type === "approval"
              ? { type: "approval-label" as const, text: label }
              : {
                  type: "question" as const,
                  taskId: choices.target.taskId,
                  questionId: choices.target.questionId,
                  answer: label,
                };
          }
        }
      }
      if (parseApprovalReply(message.text) !== undefined) return undefined;
      // The tasks already read for this pass. A label is not worth a second scan of older work;
      // a number still looks those up, because an old approval card stays answerable.
      const questions = tasks.flatMap((task) =>
        task.openQuestions.map((question) => ({
          taskId: task.taskId,
          questionId: question.questionId,
          options: question.options,
        })),
      );
      const matched = singleQuestionChoice(message.text, questions);
      return matched === undefined ? undefined : { type: "question" as const, ...matched };
    });

  const receive: ChannelReceptionService["Service"]["receive"] = (inputId, owner) =>
    Effect.gen(function* () {
      const isHome = yield* home.requireHome.pipe(
        Effect.as(true),
        Effect.catchTags({
          ChannelGatewayError: (error) =>
            error.reason === "not_home"
              ? Effect.succeed(false)
              : Effect.fail(
                  new ChannelLedger.ChannelLedgerError({
                    reason: "persistence",
                    detail: "GOAT Bot home settings could not be read.",
                  }),
                ),
        }),
      );
      const receptionId = ChannelReceptionId.make("channel-reception:" + NodeCrypto.randomUUID());
      const readAt = DateTime.formatIso(yield* DateTime.now);
      const stored = yield* ledger.beginReception({ owner, inputId, receptionId, readAt });
      if (stored === undefined || stored.requester === undefined) return;
      const message = stored.message;
      const requester = stored.requester;
      const conversationId = stored.snapshot.conversationId;
      const origin = message.replyAddress;
      const mention = mentionFor(origin, message.actor.externalActorId);

      if (!isHome) {
        yield* ledger.failReception({
          owner,
          inputId,
          receptionId,
          failure: { reason: "reception_failed", message: CHANNEL_COPY.botMoved },
          deliveries: [
            replyDelivery({
              causeKey: "reply:" + inputId,
              destination: origin,
              kind: "failure",
              text: CHANNEL_COPY.botMoved,
              inputId,
              mentionActorId: mention,
            }),
          ],
          now: readAt,
        });
        yield* wake.wake;
        return;
      }

      // The bot's copy of the message shows when reception started reading it.
      if (origin.kind === "goat") {
        yield* timeline
          .record({
            threadId: origin.threadId,
            record: {
              recordKey: "input:" + inputId,
              entry: {
                type: "message",
                role: "user",
                text: message.text,
                meta: {
                  conversationId,
                  originKind: "goat",
                  kind: "inbound",
                  inputId,
                  readAt: stored.snapshot.readAt ?? readAt,
                },
              },
            },
            revision: "read",
          })
          .pipe(Effect.ignore);
      }

      // The person as they stand now: a Slack link removed or narrowed since the message
      // arrived counts.
      const judgedNow = Effect.gen(function* () {
        if (message.kind !== "slack" && message.kind !== "imessage") return requester;
        const linked =
          requester.externalActorId === undefined
            ? undefined
            : yield* ledger.findIdentity({
                connectionId: message.connectionId,
                externalActorId: requester.externalActorId,
              });
        if (linked === undefined) return undefined;
        return {
          ...requester,
          runtimeModeCeiling: lowerRuntimeMode(
            requester.runtimeModeCeiling,
            linked.runtimeModeCeiling,
          ),
          grantedScopes: requester.grantedScopes.filter((scope) =>
            linked.grantedScopes.includes(scope),
          ),
        };
      });
      const tasks = yield* ledger.listConversationTasks(conversationId);

      // A number or an option label is decided here, before the model. A number on an approval
      // card becomes that button's label ("Deny A1") so the approval parser and mayAnswerFor
      // run unchanged. Agents never answer approvals or questions, so MCP goes the usual way.
      const choice = yield* inboundChoice(message, conversationId, tasks);
      const approvalReply =
        choice?.type === "question"
          ? undefined
          : message.intent === "message" && requester.originKind !== "mcp"
            ? parseApprovalReply(choice?.type === "approval-label" ? choice.text : message.text)
            : undefined;
      const answer =
        approvalReply === undefined
          ? undefined
          : yield* decideApprovalReply(
              approvalReply,
              conversationId,
              inputId,
              judgedNow,
              message.kind,
            );
      if (answer !== undefined) {
        yield* ledger.completeReception({
          owner,
          inputId,
          receptionId,
          replyText: answer.text,
          decision: {
            replyText: answer.text,
            action:
              answer.options === undefined
                ? { type: "report_only" }
                : { type: "clarify", question: answer.text, options: answer.options },
          },
          deliveries: [
            replyDelivery({
              causeKey: "reply:" + inputId,
              destination: origin,
              kind: answer.options === undefined ? "receipt" : "question",
              text: answer.text,
              inputId,
              task: answer.task,
              mentionActorId: mention,
              options: answer.options,
            }),
          ],
          now: DateTime.formatIso(yield* DateTime.now),
        });
        yield* wake.wake;
        return;
      }
      const hosts = yield* remoteWorkers.knownHosts;
      const bot = (yield* ledger.getBot(stored.ownerId))?.bot;
      const targets = yield* allowedTargets(bot?.projectId);
      const outcome: ReceptionOutcome =
        choice?.type === "question"
          ? {
              ok: true,
              result: {
                replyText: CHANNEL_COPY.answerForwarded,
                action: {
                  type: "answer_question",
                  taskId: choice.taskId,
                  questionId: choice.questionId,
                  answer: choice.answer,
                },
              },
            }
          : message.intent === "answer" &&
              message.taskId !== undefined &&
              message.questionId !== undefined
            ? {
                ok: true,
                result: {
                  replyText: CHANNEL_COPY.answerForwarded,
                  action: {
                    type: "answer_question",
                    taskId: message.taskId,
                    questionId: message.questionId,
                    answer: message.text.trim() === "" ? "(no answer)" : message.text,
                  },
                },
              }
            : yield* Effect.gen(function* () {
                const tail = yield* ledger.readConversationTail(
                  conversationId,
                  CHANNEL_RECEPTION_TAIL_LIMITS.messages,
                );
                const shells = yield* listThreads;
                const recent = recentThreads(shells, targets, bot?.threadId);
                const facts = yield* hostFacts(shells);
                const notes = yield* readChannelBotNotes(fileSystem, botFiles);
                // Everything this pass sees about other work is judged with the link as it is now.
                const viewer = yield* viewerNow(requester, message.connectionId);
                const journal = journalFor(
                  yield* visibleTasks(viewer, conversationId).pipe(
                    Effect.orElseSucceed((): ReadonlyArray<ChannelTask> => []),
                  ),
                );
                const skills = yield* listChannelBotSkills(fileSystem, path, botFiles);
                const base: ChannelReceptionInput = {
                  mode: "input",
                  conversationId,
                  originKind: message.kind,
                  inputText: message.text,
                  tail: boundTail(
                    tail.flatMap((entry) =>
                      entry.inputId === inputId
                        ? []
                        : [
                            { role: "user" as const, text: entry.text, at: entry.receivedAt },
                            ...(entry.replyText === undefined
                              ? []
                              : [
                                  {
                                    role: "assistant" as const,
                                    text: entry.replyText,
                                    at: entry.receivedAt,
                                  },
                                ]),
                          ],
                    ),
                  ),
                  tasks: tasks.map((task) => ({
                    taskId: task.taskId,
                    ...(task.kind === undefined ? {} : { kind: task.kind }),
                    title: task.title,
                    status: task.status,
                    ...(task.resultSummary === undefined
                      ? {}
                      : { resultSummary: task.resultSummary }),
                    ...((task.worker?.host ?? task.host) === undefined
                      ? {}
                      : { host: task.worker?.host ?? task.host }),
                    ...((task.observed?.pullRequests ?? []).length === 0
                      ? {}
                      : { pullRequests: task.observed!.pullRequests.map(pullRequestLabel) }),
                    openQuestions: task.openQuestions.map((question) => ({
                      questionId: question.questionId,
                      text: question.text,
                    })),
                    ...(task.observed?.result === undefined
                      ? {}
                      : { evidence: channelEvidenceLabels(task.observed.result) }),
                  })),
                  allowedTargets: targets,
                  ...(hosts.length === 0 ? {} : { allowedHosts: hosts }),
                  ...(recent.length === 0 ? {} : { recentThreads: recent }),
                  ...(facts.length === 0 ? {} : { hostFacts: facts }),
                  ...(notes === "" ? {} : { notes }),
                  ...(journal === "" ? {} : { journal }),
                  ...(skills.length === 0 ? {} : { skills }),
                  requester,
                };
                const first = yield* generateOutcome({ ...base, readsAllowed: true });
                if (!first.ok || first.result.action.type !== "read") return first;
                // One round of reads, then the answer. Reads run within what this requester
                // may see; a second request to read is answered with what the pass wrote.
                // The first pass can take most of a minute; judge the link again before reading.
                const reader = yield* viewerNow(requester, message.connectionId);
                const results = yield* runReads(
                  first.result.action.reads,
                  reader,
                  conversationId,
                  message.connectionId,
                  inputId,
                );
                // The first pass wrote its queries from what it could see then. When the link
                // narrowed since, a query may quote work the person can no longer see.
                const narrowed =
                  reader.principalId !== viewer.principalId ||
                  viewer.grantedScopes.some((scope) => !reader.grantedScopes.includes(scope));
                const readResults = narrowed
                  ? results.map((result) => ({ ...result, query: "(withheld)" }))
                  : results;
                const journalNow = journalFor(
                  yield* visibleTasks(reader, conversationId).pipe(
                    Effect.orElseSucceed((): ReadonlyArray<ChannelTask> => []),
                  ),
                );
                const { journal: _journal, ...rest } = base;
                const second = yield* generateOutcome({
                  ...rest,
                  ...(journalNow === "" ? {} : { journal: journalNow }),
                  readsAllowed: false,
                  readResults,
                });
                // A pass that asks to read again found nothing to answer from; say so plainly.
                if (!second.ok || second.result.action.type !== "read") return second;
                const foundNothing: ReceptionOutcome = {
                  ok: true,
                  result: {
                    replyText: CHANNEL_COPY.readFoundNothing,
                    action: { type: "report_only" },
                  },
                };
                return foundNothing;
              });

      const now = DateTime.formatIso(yield* DateTime.now);
      if (!outcome.ok) {
        const reply = CHANNEL_COPY.receptionFailedBecause[outcome.failure];
        yield* ledger.failReception({
          owner,
          inputId,
          receptionId,
          failure: { reason: "reception_failed", message: reply },
          deliveries: [
            replyDelivery({
              causeKey: "reply:" + inputId,
              destination: origin,
              kind: "failure",
              text: reply,
              inputId,
              mentionActorId: mention,
            }),
          ],
          now,
        });
        yield* wake.wake;
        return;
      }
      const decision = outcome.result;

      // Notes shape every later reply, so a note is kept only when a person asked for it in this
      // input: the quote the model returns must occur in the message itself, never in the tail.
      // This records the request; it does not prove intent, and it fails closed.
      const rememberRefusal =
        decision.remember === undefined
          ? undefined
          : requester.originKind === "mcp"
            ? "not_a_person"
            : decision.rememberQuote === undefined
              ? "missing_quote"
              : !quotedFromInput(decision.rememberQuote, message.text)
                ? "quote_not_in_input"
                : undefined;
      if (decision.remember !== undefined && rememberRefusal !== undefined) {
        yield* Effect.logInfo("GOAT Bot note dropped", { inputId, reason: rememberRefusal });
      }
      // Saved before the result commits so a restart re-runs this input and saves it then; the note
      // names its input, so a second pass for the same input does not add it twice.
      if (decision.remember !== undefined && rememberRefusal === undefined) {
        yield* appendChannelBotNote(fileSystem, botFiles, decision.remember, readAt, inputId).pipe(
          Effect.catch((cause) => Effect.logWarning("GOAT Bot note was not saved", { cause })),
        );
      }

      let replyText = decision.replyText;
      let finalDecision = decision;
      let createdTask:
        | { readonly task: ChannelTask; readonly event: ReturnType<typeof makeTaskEvent> }
        | undefined;
      const taskEvents: Array<ChannelLedger.ChannelTaskEventWrite> = [];
      const deliveries: Array<ChannelLedger.ChannelOutboxInsert> = [];
      const action = decision.action;

      // A project question is worded by the server from the projects it would offer, so the
      // person sees the same real projects the dispatcher would ask about.
      if (action.type === "clarify" && action.about === "project") {
        const shells = yield* projects.listShells().pipe(Effect.orElseSucceed(() => []));
        const real = shells.filter((shell) => shell.id !== bot?.projectId);
        const asked = yield* projectChoices(
          real.length > 0 ? real : shells,
          shells.some((shell) => shell.id === bot?.projectId),
        );
        replyText = asked.text;
        finalDecision = {
          ...decision,
          replyText,
          action: {
            type: "clarify",
            question: asked.text,
            options: asked.choices,
            about: "project",
          },
        };
      }

      let joining: ChannelTask | undefined;
      if (action.type === "create_task" || action.type === "run_turn") {
        // People start work; agents may only report on or answer existing work.
        const mayStart =
          requester.originKind !== "mcp" &&
          requester.grantedScopes.includes("orchestration:operate");
        // Busy input: asking for a turn while this conversation's turn runs joins that turn.
        joining = mayStart && action.type === "run_turn" ? turnToSteer(tasks) : undefined;
        // The task list was read before the model answered; join only a turn still running now.
        if (joining !== undefined) {
          const now = yield* ledger.getTask(joining.taskId);
          if (now?.task.status !== "running") joining = undefined;
        }
        if (!mayStart) {
          replyText = CHANNEL_COPY.agentCannotCreateWork;
          finalDecision = { replyText, action: { type: "report_only" } };
        } else if (joining === undefined) {
          const taskId = taskIdFor(inputId, 0);
          // Only a task the person asked, in this input, to change or forget a note may edit them.
          const notesChangeRequested =
            action.notesChangeRequested !== undefined &&
            quotedFromInput(action.notesChangeRequested, message.text)
              ? action.notesChangeRequested
              : undefined;
          const task: ChannelTask = {
            taskId,
            ...(action.type === "run_turn" ? { kind: "turn" as const } : {}),
            conversationId,
            originBindingId: stored.snapshot.bindingId,
            originAddress: origin,
            originInputId: inputId,
            requester,
            title: action.title,
            instruction: action.instruction,
            status: "received",
            version: 1,
            generation: 1,
            ...(action.type !== "create_task" || action.projectId === undefined
              ? {}
              : { projectId: action.projectId }),
            // The dispatcher checks the host again before anything runs there.
            ...(action.type !== "create_task" || action.host === undefined
              ? {}
              : { host: action.host }),
            ...(notesChangeRequested === undefined ? {} : { notesChangeRequested }),
            openQuestions: [],
            createdAt: now,
            updatedAt: now,
          };
          createdTask = {
            task,
            event: makeTaskEvent(
              { ...task, version: 0 },
              {
                type: "task.created",
                payload: {
                  title: task.title,
                  instruction: task.instruction,
                  originInputId: inputId,
                  ...(notesChangeRequested === undefined ? {} : { notesChangeRequested }),
                },
              },
              now,
              { eventId: taskEventIdFor(taskId, 1) },
            ),
          };
          if (bot !== undefined) deliveries.push(chipDelivery(task, bot));
          const running = yield* ledger.countBusyTasks({
            ownerId: requester.ownerId,
            principalId: requester.principalId,
          });
          if (running >= WORKERS_PER_REQUESTER) {
            replyText +=
              " It's queued: " +
              running +
              " of your things are running, and it starts when one finishes.";
          }
        }
      }

      // A follow-up joins its workstream through the ledger: recorded here with the reply, then sent
      // by the dispatcher, which binds the task to the run that took it. Completion waits for that.
      const followTaskId = action.type === "follow_up" ? action.taskId : joining?.taskId;
      if (followTaskId !== undefined) {
        const storedTask = yield* ledger.getTask(followTaskId);
        const sender = requester.originKind === "mcp" ? undefined : yield* judgedNow;
        const running =
          storedTask !== undefined &&
          storedTask.task.conversationId === conversationId &&
          storedTask.task.status === "running" &&
          storedTask.task.worker !== undefined &&
          storedTask.task.worker.host === undefined;
        if (!running) {
          // The turn this message was joining ended after the check above. Retrying the input
          // starts the turn it asked for instead of dropping it.
          if (action.type === "run_turn") {
            return yield* new ChannelLedger.ChannelLedgerError({
              reason: "version_conflict",
              detail: "The turn this message was joining ended; reading it again.",
            });
          }
          replyText =
            action.type === "follow_up"
              ? "That work isn't running anymore. Tell me what you'd like done and I'll start it."
              : replyText;
          finalDecision = { replyText, action: { type: "report_only" } };
        } else if (sender === undefined || !mayAnswerFor(sender, storedTask.task.requester)) {
          replyText = CHANNEL_COPY.answerNotAllowed;
          finalDecision = { replyText, action: { type: "report_only" } };
        } else {
          const prepared = prepareTransition(
            storedTask,
            {
              type: "task.followup.received",
              payload: {
                inputId,
                text: message.text,
                from: sender.displayName,
                generation: storedTask.task.generation,
              },
            },
            now,
            bot,
            {
              actor: "user",
              eventId: taskEventIdFor(storedTask.task.taskId, storedTask.task.version + 1),
              forward: true,
              pendingAnswerMessageId: turnSteerIdsFor(inputId).messageId,
            },
          );
          if (prepared.ok) {
            taskEvents.push(prepared.write);
            deliveries.push(...prepared.deliveries);
            finalDecision = { replyText, action: { type: "follow_up", taskId: followTaskId } };
          } else {
            finalDecision = { replyText, action: { type: "report_only" } };
          }
        }
      }

      // Stopping records each stop with the reply; the dispatcher then stops the worker and its
      // subagents from the ledger, so a crash after the reply still stops them.
      if (action.type === "stop_work") {
        const sender = requester.originKind === "mcp" ? undefined : yield* judgedNow;
        const viewer = yield* viewerNow(requester, message.connectionId);
        const named =
          action.taskId === undefined ? undefined : yield* ledger.getTask(action.taskId);
        const candidates =
          action.taskId === undefined
            ? yield* openAndRecentTasks(viewer, conversationId)
            : named !== undefined && canSeeTask(viewer, named.task, conversationId)
              ? [named.task]
              : [];
        const stoppable = candidates.filter(
          (task) =>
            (task.status === "received" ||
              task.status === "dispatching" ||
              task.status === "running" ||
              task.status === "waiting_input") &&
            sender !== undefined &&
            mayAnswerFor(sender, task.requester),
        );
        const stopped: Array<string> = [];
        for (const task of stoppable) {
          const storedTask = yield* ledger.getTask(task.taskId);
          if (storedTask === undefined) continue;
          const prepared = prepareTransition(
            storedTask,
            {
              type: "task.cancelled",
              payload: { reason: "Stopped by " + sender!.displayName + "." },
            },
            now,
            bot,
            {
              actor: "user",
              eventId: taskEventIdFor(storedTask.task.taskId, storedTask.task.version + 1),
              narrate: true,
              forward: true,
            },
          );
          if (!prepared.ok) continue;
          taskEvents.push(prepared.write);
          deliveries.push(...prepared.deliveries);
          stopped.push(storedTask.task.title);
        }
        replyText =
          sender === undefined
            ? CHANNEL_COPY.agentCannotStopWork
            : stopped.length === 0
              ? "There's nothing running that you can stop."
              : "Stopping " + stopped.join(", ") + ".";
        finalDecision = { replyText, action };
      }

      if (action.type === "move_task") {
        const storedTask = yield* ledger.getTask(action.taskId);
        // Moving restarts work under the asker's ceiling, so the mover needs what an answerer needs.
        const mover = requester.originKind === "mcp" ? undefined : yield* judgedNow;
        if (requester.originKind === "mcp") {
          // Agents move work through channel_task_move, which checks their own ceiling.
          replyText = CHANNEL_COPY.agentCannotMoveWork;
          finalDecision = { replyText, action: { type: "report_only" } };
        } else if (storedTask === undefined || storedTask.task.conversationId !== conversationId) {
          replyText = "I couldn’t match that to work in this conversation. Which task do you mean?";
          finalDecision = { replyText, action: { type: "clarify", question: replyText } };
        } else if (mover === undefined || !mayAnswerFor(mover, storedTask.task.requester)) {
          replyText = CHANNEL_COPY.agentCannotMoveWork;
          finalDecision = { replyText, action: { type: "report_only" } };
        } else {
          finalDecision = yield* remoteWorkers
            .move({
              taskId: action.taskId,
              host: action.host,
              actor: "user",
              owner,
              callerCeiling: mover.runtimeModeCeiling,
            })
            .pipe(
              Effect.map((moved) => ({
                // The task's own narration explains the move; the reply only acknowledges it.
                replyText: "Moving it to " + moved.host + ".",
                action,
              })),
              Effect.catchTags({
                ChannelTaskMoveError: (error) =>
                  Effect.succeed({
                    replyText: error.message,
                    action: { type: "report_only" as const },
                  }),
              }),
            );
          replyText = finalDecision.replyText;
        }
      }

      if (action.type === "answer_question") {
        const answerer = yield* judgedNow;
        const { stored, refused } = yield* openQuestionTask(ledger, { ...action, conversationId });
        if (refused !== undefined) {
          finalDecision = refused;
          replyText = finalDecision.replyText;
        } else if (answerer === undefined || !mayAnswerFor(answerer, stored.task.requester)) {
          replyText = CHANNEL_COPY.answerNotAllowed;
          finalDecision = { replyText, action: { type: "report_only" } };
        } else {
          const eventId = taskEventIdFor(stored.task.taskId, stored.task.version + 1);
          const hasWorker = stored.task.worker !== undefined;
          // A dispatcher question picks the project: match the answer to a project name or id.
          const answerText = action.answer.toLowerCase();
          // The longest matching name wins, so "goat-si" is not read as "goat".
          const matched = hasWorker
            ? undefined
            : (targets.find((target) => target.projectId === action.answer.trim()) ??
              targets
                .filter((target) => answerText.includes(target.label.toLowerCase()))
                .toSorted((left, right) => right.label.length - left.label.length)[0]);
          const prepared = prepareTransition(
            stored,
            {
              type: "task.question.answered",
              payload: { questionId: action.questionId, answer: action.answer },
            },
            now,
            bot,
            {
              actor: "user",
              eventId,
              ...(hasWorker
                ? { forward: true, pendingAnswerMessageId: answerForwardIdsFor(eventId).messageId }
                : {}),
              // A dispatcher question picks the project and may pick the machine: a known
              // host, or this one.
              ...(hasWorker
                ? {}
                : {
                    amend: (next: ChannelTask) => {
                      const machine = ChannelRemoteWorkers.meansThisMachine(action.answer)
                        ? null
                        : hosts
                            .filter((host) => answerText.includes(host.toLowerCase()))
                            .toSorted((left, right) => right.length - left.length)[0];
                      const { host: _host, ...rest } = next;
                      const placed =
                        machine === null
                          ? rest
                          : machine === undefined
                            ? next
                            : { ...rest, host: machine };
                      return matched === undefined
                        ? placed
                        : { ...placed, projectId: matched.projectId };
                    },
                  }),
            },
          );
          if (prepared.ok) {
            taskEvents.push(prepared.write);
            deliveries.push(...prepared.deliveries);
          }
        }
      }

      const relatedTask = createdTask?.task;
      deliveries.unshift(
        replyDelivery({
          causeKey: "reply:" + inputId,
          destination: origin,
          kind: finalDecision.action.type === "clarify" ? "question" : "receipt",
          text: replyText,
          inputId,
          task: relatedTask,
          mentionActorId: mention,
          options:
            finalDecision.action.type === "clarify" ? finalDecision.action.options : undefined,
        }),
      );

      const committed = yield* ledger.completeReception({
        owner,
        inputId,
        receptionId,
        replyText,
        decision: finalDecision,
        ...(createdTask === undefined ? {} : { createdTask }),
        taskEvents,
        deliveries,
        now,
      });
      if (!committed) {
        yield* Effect.logDebug("channel reception result dropped; a newer pass owns the input", {
          inputId,
          receptionId,
        });
      }
      yield* wake.wake;
    });

  const narrationFor = (task: ChannelTask, event: ChannelLedger.ChannelPendingEvent["event"]) => {
    switch (event.type) {
      case "task.dispatch.claimed":
        return event.payload.target.placementReason === undefined
          ? undefined
          : {
              kind: "receipt" as const,
              text: task.title + " → " + event.payload.target.placementReason,
            };
      case "task.completed":
        // A turn's summary is GOAT Bot's own answer, written for the person on the bot's model.
        if (task.kind === "turn") {
          return {
            kind: "result" as const,
            text: event.payload.summary.trim() === "" ? "Done." : event.payload.summary,
          };
        }
        return {
          kind: "result" as const,
          text:
            "Done: " +
            task.title +
            (event.payload.summary.trim() === "" ? "" : "\n" + event.payload.summary),
        };
      case "task.failed":
        return {
          kind: "failure" as const,
          text:
            "Couldn't finish: " +
            task.title +
            ": " +
            (event.payload.summary ?? event.payload.reason),
        };
      case "task.progress":
        return event.payload.milestone === true
          ? { kind: "receipt" as const, text: event.payload.summary }
          : undefined;
      case "task.moved":
        return { kind: "receipt" as const, text: movedNarration(event.payload) };
      case "task.cancelled":
        return { kind: "failure" as const, text: "Stopped: " + task.title };
      case "task.question.opened":
        return {
          kind: "question" as const,
          text: event.payload.question.text,
          options: event.payload.question.options,
        };
      default:
        return undefined;
    }
  };

  const narrate: ChannelReceptionService["Service"]["narrate"] = (pending, owner) =>
    Effect.gen(function* () {
      const stored = yield* ledger.getTask(pending.event.taskId);
      const now = DateTime.formatIso(yield* DateTime.now);
      if (stored !== undefined && pending.event.type === "task.worker.observed") {
        const deliveries = yield* approvalCards(
          stored.task,
          pending.event.payload.observed.needsYou,
        );
        const result = pending.event.payload.observed.result;
        const evidence =
          result?.observedCheck !== undefined && result.observedCheck.status !== "running"
            ? channelEvidenceSentence(result, stored.task.title)
            : null;
        // GOAT Bot's card shows the check as it lands; text channels get one sentence.
        if (evidence !== null && stored.task.originAddress.kind !== "goat") {
          deliveries.push(
            replyDelivery({
              causeKey: "narration:" + pending.event.eventId + ":evidence",
              destination: stored.task.originAddress,
              kind: "receipt",
              text: evidence,
              task: stored.task,
            }),
          );
        }
        yield* ledger.completeNarration({ owner, sequence: pending.sequence, deliveries, now });
        yield* wake.wake;
        return;
      }
      const base = stored === undefined ? undefined : narrationFor(stored.task, pending.event);
      if (stored === undefined || base === undefined) {
        yield* ledger.completeNarration({ owner, sequence: pending.sequence, deliveries: [], now });
        return;
      }
      const task = stored.task;
      const origin = task.originAddress;
      const bot = (yield* ledger.getBot(stored.ownerId))?.bot;
      // In GOAT Bot a task's card is its result: it already shows the outcome, the summary and
      // the checks, so a message repeating them would say everything twice. A turn is GOAT Bot's
      // own answer and stays a message.
      const cardIsResult =
        bot !== undefined &&
        task.kind !== "turn" &&
        (base.kind === "result" || base.kind === "failure");
      if (cardIsResult && origin.kind === "goat") {
        // The outcome is delivered as the card itself, under the narration's key, so the work
        // queue still sees the result reach the person. The timeline records each card version
        // once, so this adds no second item.
        yield* ledger.completeNarration({
          owner,
          sequence: pending.sequence,
          deliveries: [chipDelivery(task, bot, "narration:" + pending.event.eventId + ":origin")],
          now,
        });
        yield* wake.wake;
        return;
      }
      const plain = splitChannelResultText(base.text).text;
      const baseText = plain === "" ? base.text : plain;
      // The requester's own words set the reply's language; the worker's summary may use another.
      const request = yield* ledger.getInput(task.originInputId);
      const requestTail =
        request === undefined
          ? []
          : [{ role: "user" as const, text: request.message.text, at: request.message.receivedAt }];
      // Milestones, questions and a turn's answer keep the words written for the person.
      const worded =
        pending.event.type === "task.progress" ||
        base.kind === "question" ||
        (task.kind === "turn" && base.kind === "result")
          ? baseText
          : Option.match(
              yield* generate({
                mode: "task_event",
                conversationId: task.conversationId,
                originKind: task.requester.originKind,
                taskEvent: { taskId: task.taskId, type: pending.event.type, summary: baseText },
                tail: requestTail,
                tasks: [],
                allowedTargets: [],
                requester: task.requester,
              }),
              {
                onNone: () => baseText,
                onSome: (result) => splitChannelResultText(result.replyText).text || baseText,
              },
            );
      // Text channels have no card, so meaningful verification rides along as one sentence.
      const evidence =
        origin.kind !== "goat" && (base.kind === "result" || base.kind === "failure")
          ? channelEvidenceSentence(task.observed?.result)
          : null;
      const deliveries = [
        replyDelivery({
          causeKey: "narration:" + pending.event.eventId + ":origin",
          destination: origin,
          kind: base.kind,
          text: evidence === null ? worded : worded + "\n\n" + evidence,
          task,
          mentionActorId: mentionFor(origin, task.requester.externalActorId),
          options: "options" in base ? base.options : undefined,
        }),
      ];
      // Work started elsewhere shows up in the bot as its card; its result is on the card, and
      // only receipts and a turn's answer also arrive as messages.
      if (
        bot !== undefined &&
        origin.kind !== "goat" &&
        base.kind !== "question" &&
        !cardIsResult
      ) {
        deliveries.push(
          replyDelivery({
            causeKey: "narration:" + pending.event.eventId + ":bot",
            destination: botAddress(bot),
            kind: base.kind,
            text: worded,
            task,
          }),
        );
      }
      yield* ledger.completeNarration({ owner, sequence: pending.sequence, deliveries, now });
      yield* wake.wake;
    });

  return ChannelReceptionService.of({ receive, narrate });
});

export const layer = Layer.effect(ChannelReceptionService, make);
