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
  type BotId,
  CHANNEL_HOST_WORKSPACE_LABEL,
  type ChannelInputId,
  type ChannelConversationId,
  type ChannelReceptionHostFact,
  type ChannelReceptionInput,
  type ChannelReceptionRead,
  type ChannelReceptionReadResult,
  type ChannelReceptionResult,
  type ChannelRequester,
  type ChannelTask,
  type ChannelTaskNeedsYou,
  ChannelQuestionId,
  ChannelReceptionId,
  CommandId,
  CHANNEL_RECEPTION_TAIL_LIMITS,
  type OrchestrationV2ThreadShell,
} from "@goat/contracts";
import {
  channelEvidenceCorrection,
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
import { isUnlinkedPrincipal, mayDirect } from "./ChannelGateway.ts";
import * as ChannelBotHome from "./ChannelBotHome.ts";
import * as ChannelBotProfiles from "./ChannelBotProfiles.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRemoteWorkers from "./ChannelRemoteWorkers.ts";
import * as SlackChannelSettings from "./SlackChannelSettings.ts";
import { currentChannelIdentity } from "./channelCurrentIdentity.ts";
import { currentRequester } from "./channelDispatchAuthority.ts";
import { type ApprovalVia, senderOf } from "./channelSenderAuthority.ts";
import { makeChannelProjectChoices } from "./channelProjectChoices.ts";
import * as ChannelWake from "./ChannelWake.ts";
import * as tt from "./channelTaskThreadRefusal.ts";
import {
  channelBotFilesFor,
  listChannelBotSkills,
  quotedFromInput,
  readChannelBotNotes,
} from "./channelBotNotes.ts";
import { droppedNoteNotice } from "./channelBotNoteTabEdits.ts";
import { ChannelBotNoteWriter } from "./channelBotNoteWriter.ts";
import {
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
import { CHANNEL_COPY, inboundTextWithFiles } from "./channelCopy.ts";
import * as ChannelRemoteRecall from "./channelRemoteRecall.ts";
import {
  approvalCard,
  approvalReason,
  approvalSent,
  type ApprovalReply,
  type OpenApprovalCard,
  openApprovalCards,
  parseApprovalReply,
} from "./channelApprovalCards.ts";
import { askForApprovalCode, pendingApprovals } from "./channelApprovalReplies.ts";
import { replyDelivery, turnAnswerReplyTo } from "./channelReplyDelivery.ts";
import { correctionTellsEvidence, isCheckCorrection } from "./channelCheckCorrection.ts";
import { makeInboundChoices } from "./channelInboundChoice.ts";
import {
  answerNativeQuestion,
  approvalRequestDetail,
  nativeQuestionDeliveries,
} from "./channelNativeQuestionCards.ts";
import { makeRoutineInputs, ROUTINE_COPY, routineDecision } from "./channelRoutineInputs.ts";
import { mayAnswerTask, openQuestionTask, questionTextForModel } from "./channelQuestionAnswers.ts";
import { isOpenItem, pendingDigest, workItemState } from "./channelWorkQueue.ts";
import { personMessageEntry } from "./channelPersonMessage.ts";
import { WORKERS_PER_REQUESTER } from "./ChannelDispatcher.ts";
import { answerForwardIdsFor, taskEventIdFor, turnSteerIdsFor } from "./channelIds.ts";
import {
  botAddress,
  chipDelivery,
  makeCreatedTasks,
  narrationFor,
  prepareTransition,
} from "./channelTaskWrites.ts";

/** How long a reception pass may take before the sender gets a failure note instead. */
const CHANNEL_RECEPTION_TIMEOUT_MS = 45_000;

type ReceptionOutcome =
  | { readonly ok: true; readonly result: ChannelReceptionResult }
  | { readonly ok: false; readonly failure: TextGenerationFailureKind; readonly reply?: string };
const receptionFailure = (failure: TextGenerationFailureKind): ReceptionOutcome => ({
  ok: false,
  failure,
});
// No reply goes out under a name the person changed; this one says why instead.
const profileUnreadable: ReceptionOutcome = {
  ok: false,
  failure: "unavailable",
  reply: "I couldn't read that: GOAT Bot's name and purpose could not be read on its computer.",
};
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
    readonly acknowledgeSession: (
      i: ChannelReceptionInput,
      botId: BotId,
    ) => Effect.Effect<string | undefined>;
    readonly isDeterministicReply: (
      stored: ChannelLedger.ChannelStoredInput,
    ) => Effect.Effect<boolean, ChannelLedger.ChannelLedgerError>;
  }
>()("goat/channels/ChannelReceptionService") {}

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

const make = Effect.gen(function* () {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const routineInputs = yield* makeRoutineInputs;
  const slackSettings = yield* SlackChannelSettings.SlackChannelSettings;
  const identityNow = (input: {
    readonly connectionId: string;
    readonly externalActorId: string;
  }) =>
    currentChannelIdentity(input).pipe(
      Effect.provideService(ChannelLedger.ChannelLedger, ledger),
      Effect.provideService(SlackChannelSettings.SlackChannelSettings, slackSettings),
    );
  const home = yield* ChannelBotHome.ChannelBotHome;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const profiles = yield* ChannelBotProfiles.ChannelBotProfiles;
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
  const botNotes = yield* ChannelBotNoteWriter;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  // Absent in embeddings without memory; the bot then reads only its notes and the ledger.
  const memoryService = yield* Effect.serviceOption(MemoryService.MemoryService);
  const memorySync = yield* Effect.serviceOption(MemorySyncService.MemorySyncService);
  const remoteThreadRecall = yield* ChannelRemoteRecall.makeRemoteThreadRecall;

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
      const linked = yield* identityNow({
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
          (yield* identityNow({ connectionId, externalActorId: requester.externalActorId }).pipe(
            Effect.orElseSucceed(() => undefined),
          ))?.principalId === requester.principalId);
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
          const notes = yield* readChannelBotNotes(botFiles, read.query);
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
            return yield* remoteThreadRecall(task, { ...worker, host: worker.host }, viewer);
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
  ): Effect.Effect<
    ReadonlyArray<ChannelReceptionReadResult & { readonly fallbacks: ReadonlyArray<string> }>
  > =>
    Effect.forEach(
      reads,
      (read) =>
        runRead(read, viewer, conversationId, connectionId, inputId).pipe(
          Effect.timeoutOption(CHANNEL_READ_TIMEOUT_MS),
          Effect.map((value) =>
            ChannelRemoteRecall.presentRead(read, Option.getOrUndefined(value)),
          ),
          Effect.catch((cause) =>
            Effect.logWarning("GOAT Bot read failed", { kind: read.kind, cause }).pipe(
              Effect.as(ChannelRemoteRecall.presentRead(read, "(could not be read)")),
            ),
          ),
        ),
      { concurrency: "unbounded" },
    );

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
    via: ApprovalVia,
  ) =>
    Effect.gen(function* () {
      if (answerer === undefined || !mayDirect(answerer, via.connectionId, card.task)) {
        return CHANNEL_COPY.approvalNotAllowed;
      }
      const host = card.approval.host;
      if (host !== undefined) {
        const reason = approvalReason(decision, answerer, via.kind);
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
            reason: approvalReason(decision, answerer, via.kind),
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
        const detail = yield* approvalRequestDetail(card.approval, threads);
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
            mentionActorId: tt.mentionFor(task.originAddress, task.requester.externalActorId),
            options: words.options,
            questionId: ChannelQuestionId.make(card.approval.requestId),
            byWord: true,
          }),
        );
      }
      deliveries.push(...(yield* nativeQuestionDeliveries(task, listed, threads)));
      return deliveries;
    });

  /**
   * What an approve or deny reply does: a code answers the request it was issued for, or says it
   * was already answered; a bare verb answers nothing and repeats the open requests with their
   * codes (channelApprovalReplies). Undefined means the message was not about a card.
   */
  const decideApprovalReply = (
    reply: ApprovalReply,
    conversationId: ChannelConversationId,
    inputId: ChannelInputId,
    answerer: Effect.Effect<ChannelRequester | undefined, ChannelLedger.ChannelLedgerError>,
    via: ApprovalVia,
  ) =>
    Effect.gen(function* () {
      const open = yield* pendingApprovals(
        openApprovalCards(yield* ledger.listConversationNeedsYou(conversationId)),
        threads,
      );
      if (reply.code === undefined) {
        if (open.length === 0) return undefined;
        const lead = CHANNEL_COPY.approvalNeedsCode;
        return yield* askForApprovalCode({ ledger, threads, conversationId, open, lead });
      }
      const requestId = yield* ledger.approvalRequestForCode({ conversationId, code: reply.code });
      if (requestId === undefined) return undefined;
      const card = open.find((candidate) => candidate.approval.requestId === requestId);
      if (card === undefined) {
        return { text: CHANNEL_COPY.approvalAlreadyAnswered, options: undefined, task: undefined };
      }
      return {
        text: yield* answerApproval(card, reply.decision, yield* answerer, inputId, via),
        options: undefined,
        task: card.task,
      };
    });

  const { inboundChoice, isDeterministicReply, taskViewChoice } = makeInboundChoices(
    ledger,
    threads,
  );

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
      const routine = yield* routineInputs.isRoutineInput(inputId);
      const viewChoice = routine ? undefined : yield* taskViewChoice(stored);
      if (viewChoice === undefined && (yield* tt.shouldRefuseTaskThread(ledger, stored))) {
        yield* tt.refuseTaskThread(ledger, stored, owner);
        yield* wake.wake;
        return;
      }
      const message = tt.mainThreadInput(stored).message;
      const requester = stored.requester;
      const conversationId = stored.snapshot.conversationId;
      const origin = message.replyAddress;
      const mention = tt.mentionFor(origin, message.actor.externalActorId);

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

      if (origin.kind === "goat" && !routine) {
        // The task and answer the accepted copy decided stay on the message (TimelineRecords).
        yield* timeline
          .record({
            threadId: origin.threadId,
            record: {
              recordKey: "input:" + inputId,
              entry: personMessageEntry(stored, { readAt: stored.snapshot.readAt ?? readAt }),
            },
            revision: "read",
          })
          .pipe(Effect.ignore);
      }

      // The person as they stand now: a Slack link removed or narrowed since the message
      // arrived counts.
      const judgedNow = currentRequester(requester, message.connectionId).pipe(
        Effect.provideService(ChannelLedger.ChannelLedger, ledger),
        Effect.provideService(SlackChannelSettings.SlackChannelSettings, slackSettings),
      );
      // Whether this message's sender may direct someone's task: their own task on this
      // connection, or another's within that person's limits.
      const directs = (who: ChannelRequester | undefined, task: ChannelTask) =>
        who !== undefined && mayDirect(who, message.connectionId, task);
      const tasks = yield* ledger.listConversationTasks(conversationId);

      // A number or an option label is decided here, before the model. While an approval is
      // open a number answers nothing and the open requests are repeated with their words.
      // Agents and routines never answer approvals or questions.
      const choice = routine
        ? undefined
        : (viewChoice ?? (yield* inboundChoice(message, conversationId, tasks)));
      const numberRefused =
        choice?.type === "approval-number"
          ? yield* askForApprovalCode({
              ledger,
              threads,
              conversationId,
              open: choice.open,
              lead: CHANNEL_COPY.approvalNotByNumber,
            })
          : undefined;
      const nativeAnswer =
        choice?.type === "native-question"
          ? yield* answerNativeQuestion(choice, yield* judgedNow, message, inputId, threads, ledger)
          : undefined;
      const approvalReply =
        numberRefused !== undefined || nativeAnswer !== undefined || choice?.type === "question"
          ? undefined
          : message.intent === "message" && requester.originKind !== "mcp" && !routine
            ? parseApprovalReply(choice?.type === "approval-label" ? choice.text : message.text)
            : undefined;
      const answer =
        numberRefused ??
        nativeAnswer ??
        (approvalReply === undefined
          ? yield* botNotes.tabEdit(message, inputId, readAt, routine ? undefined : judgedNow)
          : yield* decideApprovalReply(approvalReply, conversationId, inputId, judgedNow, message));
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
              byWord: "byWord" in answer && answer.byWord === true,
            }),
          ],
          now: DateTime.formatIso(yield* DateTime.now),
        });
        yield* wake.wake;
        return;
      }
      const hosts = yield* remoteWorkers.knownHosts;
      const bot = (yield* ledger.getBotById(stored.ownerId, stored.botId))?.bot;
      const targets = yield* allowedTargets(bot?.projectId);
      const recallFallbacks: Array<string> = [];
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
                const facts = yield* hostFacts(shells);
                const notes = yield* readChannelBotNotes(botFiles, message.text);
                // Everything this pass sees about other work is judged with the link as it is now.
                const viewer = yield* viewerNow(requester, message.connectionId);
                // Titles of the owner's threads are other work, so only someone who may read it sees them.
                const recent = viewer.grantedScopes.includes("orchestration:read")
                  ? recentThreads(shells, targets, bot?.threadId)
                  : [];
                const journal = journalFor(
                  yield* visibleTasks(viewer, conversationId).pipe(
                    Effect.orElseSucceed((): ReadonlyArray<ChannelTask> => []),
                  ),
                );
                const skills = yield* listChannelBotSkills(fileSystem, path, botFiles);
                const identity = yield* Effect.option(
                  profiles.identity(requester.ownerId, stored.botId),
                );
                if (Option.isNone(identity)) return profileUnreadable;
                const base: ChannelReceptionInput = {
                  mode: "input",
                  conversationId,
                  originKind: message.kind,
                  inputText: inboundTextWithFiles(message),
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
                      text: questionTextForModel(task, question),
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
                  identity: identity.value,
                  ...(routine ? { routine } : {}),
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
                // Reads take time too: results read under a link that narrowed meanwhile are dropped,
                // and everything else in the answer is judged by who the person is now.
                const current = yield* viewerNow(requester, message.connectionId);
                const narrowedDuringReads =
                  current.principalId !== reader.principalId ||
                  reader.grantedScopes.some((scope) => !current.grantedScopes.includes(scope));
                // The first pass wrote its queries from what it could see then. When the link
                // narrowed since, a query may quote work the person can no longer see.
                const narrowed =
                  current.principalId !== viewer.principalId ||
                  viewer.grantedScopes.some((scope) => !current.grantedScopes.includes(scope));
                const readResults = narrowedDuringReads
                  ? []
                  : narrowed
                    ? results.map((result) => ({ ...result, query: "(withheld)" }))
                    : results;
                recallFallbacks.push(...ChannelRemoteRecall.fallbackReasons(readResults));
                const journalNow = journalFor(
                  yield* visibleTasks(current, conversationId).pipe(
                    Effect.orElseSucceed((): ReadonlyArray<ChannelTask> => []),
                  ),
                );
                const { journal: _journal, recentThreads: _recent, ...rest } = base;
                const recentNow = current.grantedScopes.includes("orchestration:read")
                  ? recentThreads(shells, targets, bot?.threadId)
                  : [];
                const second = yield* generateOutcome({
                  ...rest,
                  ...(journalNow === "" ? {} : { journal: journalNow }),
                  ...(recentNow.length === 0 ? {} : { recentThreads: recentNow }),
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
        const reply = outcome.reply ?? CHANNEL_COPY.receptionFailedBecause[outcome.failure];
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
      const decision = routineDecision(outcome.result, routine);
      if (decision.action.type === "no_update") {
        // Nothing needs the person: the input settles with no reply delivered or shown.
        yield* ledger.completeReception({
          owner,
          inputId,
          receptionId,
          replyText: ROUTINE_COPY.noUpdate,
          decision: { replyText: ROUTINE_COPY.noUpdate, action: decision.action },
          deliveries: [],
          now,
        });
        return;
      }

      // Notes are the owner's standing rules for every conversation, so only a person linked now
      // may change them; someone let in without a link, or whose access ended, may not.
      const noteWriter = requester.originKind === "mcp" ? undefined : yield* judgedNow;
      const mayChangeNotes =
        noteWriter !== undefined && !isUnlinkedPrincipal(noteWriter.principalId);
      // Notes shape every later reply, so a note is kept only when a person asked for it in this
      // input: the quote the model returns must occur in the message itself, never in the tail.
      // This records the request; it does not prove intent, and it fails closed.
      const rememberRefusal =
        decision.remember === undefined
          ? undefined
          : requester.originKind === "mcp"
            ? "not_a_person"
            : !mayChangeNotes
              ? "not_linked"
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
      const asked = "notesChangeRequested" in decision.action ? decision.action : undefined;
      const editRefusal =
        asked?.notesChangeRequested === undefined
          ? undefined
          : !mayChangeNotes
            ? "not_linked"
            : quotedFromInput(asked.notesChangeRequested, message.text)
              ? undefined
              : "quote_not_in_input";
      const saved =
        decision.remember !== undefined && rememberRefusal === undefined
          ? yield* botNotes.save(decision.remember, readAt, inputId, decision.replacesNote)
          : undefined;
      const noteNotice =
        (saved === undefined ? droppedNoteNotice(rememberRefusal) : saved.notice) ??
        droppedNoteNotice(editRefusal);
      let replyText = decision.replyText;
      let finalDecision = decision;
      // Nothing was saved, so the model's reply, which says it was, gives way to the notice.
      if (saved?.held === true && noteNotice !== undefined) {
        replyText = noteNotice;
        finalDecision = { replyText, action: { type: "report_only" } };
      }
      let createdTasks: ReturnType<typeof makeCreatedTasks> = [];
      const taskEvents: Array<ChannelLedger.ChannelTaskEventWrite> = [];
      const deliveries: Array<ChannelLedger.ChannelOutboxInsert> = [];
      const action = finalDecision.action;
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

      if (action.type === "create_task" || action.type === "run_turn") {
        // People start work; agents may only report on or answer existing work.
        const mayStart =
          requester.originKind !== "mcp" &&
          requester.grantedScopes.includes("orchestration:operate");
        if (!mayStart) {
          replyText = CHANNEL_COPY.agentCannotCreateWork;
          finalDecision = { replyText, action: { type: "report_only" } };
        } else {
          // A new turn is its own task, queued as its own run in the conversation's session;
          // only a follow_up naming a task joins that task's run.
          // Only a task the person asked, in this input, to change or forget a note may edit them.
          const notesChangeRequested =
            mayChangeNotes &&
            action.notesChangeRequested !== undefined &&
            quotedFromInput(action.notesChangeRequested, message.text)
              ? action.notesChangeRequested
              : undefined;
          createdTasks = makeCreatedTasks({
            action,
            inputId,
            conversationId,
            originBindingId: stored.snapshot.bindingId,
            originAddress: origin,
            requester,
            ...(notesChangeRequested === undefined ? {} : { notesChangeRequested }),
            bot,
            deliveries,
            now,
          });
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
      const followTaskId = action.type === "follow_up" ? action.taskId : undefined;
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
          replyText =
            "That work isn't running anymore. Tell me what you'd like done and I'll start it.";
          finalDecision = { replyText, action: { type: "report_only" } };
        } else if (sender === undefined || !directs(sender, storedTask.task)) {
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
                sender: senderOf(sender, message.connectionId),
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
            directs(sender, task),
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
        } else if (mover === undefined || !directs(mover, storedTask.task)) {
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
        } else if (
          answerer === undefined ||
          !mayAnswerTask(answerer, stored.task, message.connectionId)
        ) {
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
              payload: {
                questionId: action.questionId,
                answer: action.answer,
                inputId,
                sender: senderOf(answerer, message.connectionId),
              },
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
              ...(hasWorker || stored.task.skillProposal !== undefined
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

      const relatedTask = createdTasks[0]?.task;
      if (noteNotice !== undefined && replyText !== noteNotice) replyText += " " + noteNotice;
      replyText = ChannelRemoteRecall.keepFallbacks(replyText, undefined, recallFallbacks);
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
        ...(createdTasks[0] === undefined ? {} : { createdTask: createdTasks[0], createdTasks }),
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
          result !== undefined && isCheckCorrection(stored.task, pending.event.eventId, result)
            ? channelEvidenceCorrection(result, stored.task.title)
            : result?.observedCheck !== undefined && result.observedCheck.status !== "running"
              ? channelEvidenceSentence(result, stored.task.title)
              : null;
        // A check that lands after the result is one more sentence; GOAT Bot's chat, which shows
        // no task card, reads it as part of the result.
        if (evidence !== null) {
          const goat = stored.task.originAddress.kind === "goat";
          deliveries.push(
            replyDelivery({
              causeKey: "narration:" + pending.event.eventId + ":evidence",
              destination: stored.task.originAddress,
              kind: goat ? "result" : "receipt",
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
      const bot = (yield* ledger.getBotById(stored.ownerId, stored.botId))?.bot;
      // GOAT Bot's chat shows conversation, not task cards, so a GOAT task's outcome is told as a
      // message too; its card still carries it for the task's own view and the work queue. A turn
      // is GOAT Bot's own answer and is already a message.
      const cardIsResult =
        bot !== undefined &&
        task.kind !== "turn" &&
        (base.kind === "result" || base.kind === "failure");
      const goatOutcome = cardIsResult && origin.kind === "goat";
      const plain = splitChannelResultText(base.text).text;
      const baseText = plain === "" ? base.text : plain;
      // The requester's own words set the reply's language; the worker's summary may use another.
      const request = yield* ledger.getInput(task.originInputId);
      const requestTail =
        request === undefined
          ? []
          : [{ role: "user" as const, text: request.message.text, at: request.message.receivedAt }];
      // Milestones, questions and a turn's answer keep the words written for the person.
      const identity = yield* Effect.option(
        profiles.identity(task.requester.ownerId, stored.botId),
      );
      const worded =
        pending.event.type === "task.progress" ||
        base.kind === "question" ||
        (task.kind === "turn" && base.kind === "result") ||
        Option.isNone(identity)
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
                identity: identity.value,
                requester: task.requester,
              }),
              {
                onNone: () => baseText,
                onSome: (result) => splitChannelResultText(result.replyText).text || baseText,
              },
            );
      // A message has no card around it, so meaningful verification rides along as one sentence.
      const evidence =
        (origin.kind !== "goat" || goatOutcome) &&
        (base.kind === "result" || base.kind === "failure") &&
        !(yield* correctionTellsEvidence(ledger, task))
          ? channelEvidenceSentence(task.observed?.result)
          : null;
      const replyTo = turnAnswerReplyTo(task, base.kind);
      // The attempt the event ended, which a retry since then has moved past.
      const taskGeneration =
        "generation" in pending.event.payload ? pending.event.payload.generation : task.generation;
      const told = replyDelivery({
        // The told outcome holds the narration's key, so the work queue waits for the message the
        // person reads; a GOAT outcome's card goes alongside it under its own key.
        causeKey: "narration:" + pending.event.eventId + ":origin",
        destination: origin,
        kind: base.kind,
        text: evidence === null ? worded : worded + "\n\n" + evidence,
        replyTo,
        task,
        taskGeneration,
        mentionActorId: tt.mentionFor(origin, task.requester.externalActorId),
        options: "options" in base ? base.options : undefined,
        questionId: "questionId" in base ? base.questionId : undefined,
        interim: "interim" in base,
        questionKind: "questionKind" in base ? base.questionKind : undefined,
      });
      const deliveries =
        goatOutcome && bot !== undefined
          ? [chipDelivery(task, bot, "narration:" + pending.event.eventId + ":card"), told]
          : [told];
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
            replyTo,
            task,
            taskGeneration,
          }),
        );
      }
      yield* ledger.completeNarration({ owner, sequence: pending.sequence, deliveries, now });
      yield* wake.wake;
    });

  const acknowledgeSession = Effect.fn("ChannelReceptionService.acknowledgeSession")(function* (
    input: ChannelReceptionInput,
    botId: BotId,
  ) {
    // Without the bot's identity the session's own reply, which follows, speaks for it.
    const identity = yield* Effect.option(profiles.identity(input.requester.ownerId, botId));
    if (Option.isNone(identity)) return undefined;
    const result = yield* generate({ ...input, identity: identity.value });
    return Option.getOrUndefined(result)?.replyText.trim() || undefined;
  });
  return ChannelReceptionService.of({ receive, narrate, acknowledgeSession, isDeterministicReply });
});

export const layer = Layer.effect(ChannelReceptionService, make);
