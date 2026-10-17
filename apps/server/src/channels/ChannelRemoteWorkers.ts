/**
 * ChannelRemoteWorkers - runs ledger tasks on another machine and brings their reports back.
 *
 * A task whose requester asked for another machine (an SSH alias this machine knows) runs in
 * that machine's own GOAT, in one of its existing projects, through the same SSH launch the
 * goat_ssh_thread_launch tool uses. The launch carries an origin report binding whose id
 * derives from the task and generation. The remote stores that binding before it creates the
 * thread and refuses a second one with the same id, so relaunching a generation after a lost
 * answer can never start a second remote thread.
 *
 * One observer fiber per running remote task long-polls goat_origin_reports_wait. Reports land
 * in a local inbox first (with the cursor, in one write), then each becomes at most one ledger
 * event with an id derived from the report, committed together with its removal from the inbox.
 * While an answer is on its way to the worker every report waits, so a stale question cannot
 * move the task before the answer's run is known. A finished remote run settles the task only
 * after a short second look finds no newer run or report.
 *
 * Remote completion is weaker than local: the remote does not tell us about provider background
 * work or a restart continuation that has not started a run yet.
 *
 * Everything here writes under the channel owner token and stops when it is lost. The remote
 * session's ceiling is the requester's runtime-mode ceiling, so the remote enforces it.
 *
 * @module ChannelRemoteWorkers
 */
// @effect-diagnostics nodeBuiltinImport:off - read keys need node:crypto; the origin label is os.hostname.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import {
  type ChannelDispatchTarget,
  type ChannelTaskEventId,
  type ChannelTaskId,
  ChannelWorkerObservation,
  channelWorkerObservationEquals,
  EnvironmentId,
  type MemoryTaskGrantCeiling,
  type ModelSelection,
  ModelSelection as ModelSelectionSchema,
  PositiveInt,
  ProjectId,
  ProviderInstanceId,
  RemoteOriginReportsWaitResult,
  RemoteReport,
  RemoteRunHolds,
  RunId,
  RuntimeRequestId,
  type RuntimeMode,
  ThreadId,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import { REPORTING_NOTE } from "../remoteReports/reportFrame.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import { channelBotFilesFor, readChannelBotNotes } from "./channelBotNotes.ts";
import {
  answerForwardIdsFor,
  questionIdFor,
  remoteBranchFor,
  remoteCorrelationFor,
  remoteReportEventIdFor,
} from "./channelIds.ts";
import { channelNotesRevision, freezeChannelBrief } from "./channelBriefs.ts";
import { settleCompletedRun } from "./channelRunOutcome.ts";
import { choosePlacement } from "./channelPlacement.ts";
import { commitTransition, type ChannelTaskEventSpec } from "./channelTaskWrites.ts";
import { readNamedSkills, remoteWorkerMessage } from "./channelWorkerBrief.ts";
import { BACKGROUND_HOLD } from "./ChannelWorkerReports.ts";
import { observesUsageLimit } from "./channelWorkerObservation.ts";

/** How long one report wait may block on the remote, and the transport's extra headroom. */
export const REMOTE_WAIT_MS = 50_000;
export const REMOTE_SETTLE_WAIT_MS = 10_000;
const TRANSPORT_HEADROOM_MS = 40_000;
const READ_TIMEOUT_MS = 60_000;
const SEND_TIMEOUT_MS = 90_000;
/** A launch whose thread or first run has not shown up by then is reported as failed. */
export const LAUNCH_GRACE_MS = 300_000;
export const MAX_LAUNCH_ATTEMPTS = 3;
/** Consecutive unreachable waits before the requester hears about it, once per outage. */
export const OUTAGE_NOTICE_AFTER = 3;
const BACKOFF_START_MS = 5_000;
const BACKOFF_MAX_MS = 300_000;
const INBOX_LIMIT = 200;
const MAX_PROJECT_PAGES = 5;

/** What the requester reads. Fixed text: remote error text never reaches a channel. */
export const REMOTE_COPY = {
  unknownHost: (host: string, hosts: ReadonlyArray<string>) =>
    "I can't send work to " +
    host +
    ". Which machine should run it? " +
    [...hosts, "this machine"].join(", "),
  unreachable: (host: string) =>
    "I can't reach " +
    host +
    " right now. Answer with this machine to run it here, or ask again later.",
  noProject: (host: string) =>
    "There is no project on " +
    host +
    " to work in yet. Add one in GOAT there, then answer with its name.",
  whichProject: (host: string, names: ReadonlyArray<string>) =>
    "Which project on " + host + " should I use? " + names.join(", "),
  projectGone: (host: string) =>
    "That project is no longer on " + host + ". Which one should I use?",
  launchRefused: (host: string) => "GOAT on " + host + " refused to start the work.",
  memoryUnsupported: (host: string) =>
    "GOAT on " +
    host +
    " can't apply the memory access this task may use. Update GOAT there and ask again.",
  launchUncertain: (host: string) =>
    "I can't tell whether the work started on " +
    host +
    ". Check its threads there before asking again.",
  launchIncomplete: (host: string) => "The work on " + host + " did not start a run.",
  reportsUnsupported: (host: string) =>
    "GOAT on " + host + " is too old to report back. Update it there and ask again.",
  lost: (host: string) => "The work on " + host + " is no longer reachable from here.",
  outage: (host: string) =>
    "I can't reach " + host + " right now. The work keeps running there; I'll reconnect.",
  reconnected: (host: string) => "Reconnected to " + host + ".",
  answerRefused: (host: string, answer: string) =>
    "The coding thread on " +
    host +
    " now runs above what this task may use, so I didn’t pass on your answer (“" +
    answer +
    "”). Lower the thread’s mode there and answer again, or answer in the thread.",
  inboxOverflow: (count: number) =>
    String(count) + " older progress reports from the other machine were dropped.",
  projectModelMissing: (host: string, project: string) =>
    "The model for " +
    project +
    " on " +
    host +
    " is not available there. Pick a default model for that project in GOAT on " +
    host +
    " and answer here.",
  defaultModelMissing: (host: string, project: string) =>
    "This machine's default model is not available on " +
    host +
    ". Pick a default model for " +
    project +
    " in GOAT on " +
    host +
    " and answer here.",
} as const;

const RemoteWorkerState = Schema.Struct({
  generation: PositiveInt,
  host: Schema.String,
  cwd: Schema.String,
  correlationId: Schema.String,
  readKey: Schema.String,
  launchStartedAt: Schema.String,
  attempts: Schema.Number,
  remoteThreadId: Schema.optional(Schema.String),
  cursor: Schema.Number,
  knownRun: Schema.optional(
    Schema.Struct({
      runId: Schema.String,
      status: Schema.String,
      /** Echoed back so the wait releases when background work or a continuation ends. */
      holds: Schema.optional(RemoteRunHolds),
      /** Echoed back so the wait releases when a question opens or closes. */
      pendingRequestIds: Schema.optional(Schema.Array(RuntimeRequestId)),
      /** Echoed back so the wait releases when pull requests, requests or a usage limit change. */
      observation: Schema.optional(ChannelWorkerObservation),
    }),
  ),
  inbox: Schema.Array(RemoteReport),
  dropped: Schema.Number,
  /** The run an answer started on the remote; reports wait until the remote shows it. */
  receipt: Schema.optional(
    Schema.Struct({ eventId: Schema.String, runId: Schema.String, messageId: Schema.String }),
  ),
  /** Answers already sent, by task event id. */
  forwarded: Schema.Array(Schema.String),
  /** A finished run seen once; it settles the task if a second look finds nothing newer. */
  settleRunId: Schema.optional(Schema.String),
  outageNoticed: Schema.Boolean,
});
export type RemoteWorkerState = typeof RemoteWorkerState.Type;

const encodeState = Schema.encodeSync(Schema.fromJsonString(RemoteWorkerState));
const decodeStateOption = Schema.decodeUnknownOption(Schema.fromJsonString(RemoteWorkerState));
const decodeState = (json: string | undefined) => {
  if (json === undefined) return undefined;
  const decoded = decodeStateOption(json);
  return decoded._tag === "Some" ? decoded.value : undefined;
};
const decodeWait = Schema.decodeUnknownEffect(RemoteOriginReportsWaitResult);
const RemoteProject = Schema.Struct({
  id: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
  repositoryIdentity: Schema.optional(Schema.NullOr(Schema.Unknown)),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelectionSchema)),
});
type RemoteProject = typeof RemoteProject.Type;
const decodeProjects = Schema.decodeUnknownEffect(
  Schema.Struct({
    projects: Schema.Array(RemoteProject),
    nextCursor: Schema.optional(Schema.NullOr(Schema.Number)),
  }),
);
const decodeEnvironment = Schema.decodeUnknownEffect(
  Schema.Struct({ environmentId: EnvironmentId }),
);
/**
 * Only what the model check and placement need from orchestrator_capabilities, so newer fields
 * never break it. An older GOAT may omit driverKind or canRunChildTask; its accounts are then
 * never swapped.
 */
const OfferedProviders = Schema.Struct({
  providers: Schema.Array(
    Schema.Struct({
      providerInstanceId: Schema.String,
      driverKind: Schema.optional(Schema.String),
      displayName: Schema.optional(Schema.NullOr(Schema.String)),
      /** False for an account that cannot run work now, such as one signed out or disabled. */
      canRunChildTask: Schema.optional(Schema.Boolean),
      models: Schema.Array(Schema.Struct({ id: Schema.String })),
    }),
  ),
});
type OfferedProviders = typeof OfferedProviders.Type;
const decodeOffered = Schema.decodeUnknownEffect(OfferedProviders);
/** The quota windows goat_host_status reports for each provider account on that machine. */
const decodeHostQuotas = Schema.decodeUnknownEffect(
  Schema.Struct({
    hosts: Schema.Array(
      Schema.Struct({
        metrics: Schema.optional(
          Schema.Struct({
            quotas: Schema.Array(
              Schema.Struct({
                instanceId: Schema.String,
                limits: Schema.Struct({
                  windows: Schema.Array(
                    Schema.Struct({
                      label: Schema.String,
                      usedPercent: Schema.Number,
                      resetsAt: Schema.optional(Schema.String),
                    }),
                  ),
                }),
              }),
            ),
          }),
        ),
      }),
    ),
  }),
);
const decodeSent = Schema.decodeUnknownEffect(
  Schema.Struct({ runId: RunId, messageId: Schema.String }),
);

/** A failure's tag for logs; causes can quote remote text, so they are never printed. */
const causeTag = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause);
  return typeof failure === "object" && failure !== null && "_tag" in failure
    ? String((failure as { readonly _tag: unknown })._tag)
    : "defect";
};

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);

/** The task changed hands or moved on while a remote call was pending; nothing was sent. */
class Superseded extends Data.TaggedError("ChannelRemoteSuperseded")<{}> {}

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

/** A remote project's repository key, when the remote resolved one. */
const canonicalKeyOf = (project: RemoteProject) => {
  const identity = project.repositoryIdentity;
  if (typeof identity !== "object" || identity === null) return undefined;
  const key = (identity as { readonly canonicalKey?: unknown }).canonicalKey;
  return typeof key === "string" ? key : undefined;
};

/** "this machine" and its common spellings, in English and Korean. */
export const meansThisMachine = (text: string) =>
  /\b(this machine|here|locally|local)\b|이 기기|여기|로컬/iu.test(text);

export type RemoteResolution =
  | { readonly type: "target"; readonly target: ChannelDispatchTarget }
  | { readonly type: "question"; readonly text: string }
  | { readonly type: "local" }
  | { readonly type: "retry" };

export class ChannelRemoteWorkers extends Context.Service<
  ChannelRemoteWorkers,
  {
    /** SSH aliases this machine knows; no network. Empty when the config cannot be read. */
    readonly knownHosts: Effect.Effect<ReadonlyArray<string>>;
    /** Picks the remote project and launch settings for a received task with a host. */
    readonly resolve: (
      stored: ChannelLedger.ChannelStoredTask,
      local: {
        readonly modelSelection: ModelSelection;
        /** A model the requester's channel asks for; wins over the remote project's default. */
        readonly preferredModelSelection?: ModelSelection | undefined;
        /**
         * A project was meant (the channel's default) but is gone here, so the remote's only
         * project must not stand in for it; the requester names one instead.
         */
        readonly requireNamedProject?: boolean | undefined;
        /**
         * This machine's projects; an answer naming one (as reception matches it, by exact id or
         * title) chose a project here instead.
         */
        readonly localProjects?:
          | ReadonlyArray<{ readonly id: string; readonly title: string }>
          | undefined;
        readonly runtimeMode: RuntimeMode;
        /** The memory the worker may use, captured from the requester on this machine. */
        readonly memoryGrantCeiling?: MemoryTaskGrantCeiling | undefined;
        /** The local project the task named, to find its counterpart on the other machine. */
        readonly title?: string | undefined;
        readonly canonicalKey?: string | undefined;
      },
      owner: string,
    ) => Effect.Effect<RemoteResolution, ChannelLedger.ChannelLedgerError>;
    /** Starts (or resumes) the remote launch of a dispatching task in the background. */
    readonly launch: (
      taskId: ChannelTaskId,
      owner: string,
    ) => Effect.Effect<void, ChannelLedger.ChannelLedgerError>;
    /**
     * Chooses where a received task with a host runs, in the background: asks the requester
     * when it cannot, otherwise claims the task and launches it.
     */
    readonly dispatch: (
      taskId: ChannelTaskId,
      owner: string,
      local: {
        readonly modelSelection: ModelSelection;
        /** A model the requester's channel asks for; wins over the remote project's default. */
        readonly preferredModelSelection?: ModelSelection | undefined;
        /**
         * A project was meant (the channel's default) but is gone here, so the remote's only
         * project must not stand in for it; the requester names one instead.
         */
        readonly requireNamedProject?: boolean | undefined;
        /**
         * This machine's projects; an answer naming one (as reception matches it, by exact id or
         * title) chose a project here instead.
         */
        readonly localProjects?:
          | ReadonlyArray<{ readonly id: string; readonly title: string }>
          | undefined;
        readonly runtimeMode: RuntimeMode;
        /** The memory the worker may use, captured from the requester on this machine. */
        readonly memoryGrantCeiling?: MemoryTaskGrantCeiling | undefined;
        readonly title?: string | undefined;
        readonly canonicalKey?: string | undefined;
      },
    ) => Effect.Effect<void, ChannelLedger.ChannelLedgerError>;
    /** Sends a recorded answer to a remote worker in the background; completes the forward. */
    readonly forward: (
      pending: ChannelLedger.ChannelPendingEvent,
      owner: string,
    ) => Effect.Effect<void, ChannelLedger.ChannelLedgerError>;
    /**
     * The machine an earlier attempt of this generation may already run on, when the task now
     * points elsewhere. Starting it anywhere else could run it twice.
     */
    readonly attemptedElsewhere: (
      stored: ChannelLedger.ChannelStoredTask,
    ) => Effect.Effect<string | undefined, ChannelLedger.ChannelLedgerError>;
    /** Starts an observer for every running remote task that has none. Returns how many. */
    readonly ensure: (owner: string) => Effect.Effect<number, ChannelLedger.ChannelLedgerError>;
  }
>()("goat/channels/ChannelRemoteWorkers") {}

const make = Effect.gen(function* () {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const ssh = yield* SshRemoteDispatch.SshRemoteDispatch;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const botFiles = channelBotFilesFor(path, (yield* ServerConfig.ServerConfig).stateDir);
  const fibers = yield* FiberMap.make<string, void, never>();
  const locks = new Map<string, Semaphore.Semaphore>();
  const lockFor = (taskId: string) => {
    const held = locks.get(taskId);
    if (held !== undefined) return held;
    const created = Semaphore.makeUnsafe(1);
    locks.set(taskId, created);
    return created;
  };
  const serialized =
    (taskId: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      lockFor(taskId).withPermits(1)(effect);

  const readState = (taskId: ChannelTaskId) =>
    ledger.getRemoteWorker(taskId).pipe(Effect.map(decodeState));

  /** Patches the state row only while it still belongs to \`generation\`. */
  const stateUpdate = (
    taskId: ChannelTaskId,
    generation: number,
    change: (state: RemoteWorkerState) => RemoteWorkerState,
  ): ChannelLedger.RemoteWorkerStateUpdate => ({
    taskId,
    update: (current) => {
      const state = decodeState(current);
      if (state === undefined || state.generation !== generation) return current ?? "";
      return encodeState(change(state));
    },
  });

  const writeState = (
    owner: string,
    taskId: ChannelTaskId,
    generation: number,
    change: (state: RemoteWorkerState) => RemoteWorkerState,
  ) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      const json = yield* ledger.updateRemoteWorker({
        owner,
        now,
        update: stateUpdate(taskId, generation, change),
      });
      return decodeState(json);
    });

  // Only aliases the user wrote in SSH config; machines seen only in known_hosts are not offered.
  const knownHosts = ssh.listHosts({ probe: false }).pipe(
    Effect.map((hosts) =>
      hosts.filter((host) => host.source === "ssh-config").map((host) => host.alias),
    ),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

  /** A remote call's authority: the requester's ceiling, while this owner still runs the task. */
  const authorityFor = (taskId: ChannelTaskId, generation: number, owner: string) =>
    Effect.gen(function* () {
      if (!(yield* ledger.isOwner(owner).pipe(Effect.orElseSucceed(() => false)))) {
        return yield* new Superseded();
      }
      const stored = yield* ledger.getTask(taskId).pipe(Effect.orElseSucceed(() => undefined));
      if (stored === undefined || stored.task.generation !== generation) {
        return yield* new Superseded();
      }
      return stored.task.requester.runtimeModeCeiling;
    });

  const callHost = (
    input: {
      readonly host: string;
      readonly tool: string;
      readonly arguments: Readonly<Record<string, unknown>>;
      readonly writes: boolean;
      readonly timeoutMs: number;
    },
    authorize: Effect.Effect<RuntimeMode, Superseded>,
  ) => ssh.callHostTool(input, authorize);

  const listRemoteProjects = (host: string, authorize: Effect.Effect<RuntimeMode, Superseded>) =>
    Effect.gen(function* () {
      const projects: Array<RemoteProject> = [];
      let cursor: number | null = 0;
      for (let page = 0; page < MAX_PROJECT_PAGES && cursor !== null; page += 1) {
        const raw: unknown = yield* callHost(
          {
            host,
            tool: "goat_project_list",
            arguments: { cursor, limit: 100 },
            writes: false,
            timeoutMs: READ_TIMEOUT_MS,
          },
          authorize,
        );
        const listed: {
          readonly projects: ReadonlyArray<RemoteProject>;
          readonly nextCursor?: number | null | undefined;
        } = yield* decodeProjects(raw).pipe(
          Effect.mapError(
            () =>
              new SshRemoteDispatch.SshRemoteDispatchError({
                reason: "remote_refused",
                message: "The remote project list did not decode.",
              }),
          ),
        );
        projects.push(...listed.projects);
        cursor = listed.nextCursor ?? null;
      }
      return projects;
    });

  /** The remote project for a task, by id, local folder name, title, or being the only one. */
  const chooseProject = (
    projects: ReadonlyArray<RemoteProject>,
    hint: {
      readonly projectId?: string;
      readonly localTitle?: string;
      readonly canonicalKey?: string;
      readonly requireNamed?: boolean;
    },
  ) => {
    const byId = projects.find((project) => project.id === hint.projectId);
    if (byId !== undefined) return byId;
    // The same repository as the local project, by its canonical remote key.
    if (hint.canonicalKey !== undefined) {
      const same = projects.filter((project) => canonicalKeyOf(project) === hint.canonicalKey);
      if (same.length === 1) return same[0];
    }
    if (hint.localTitle !== undefined) {
      const title = hint.localTitle.toLowerCase();
      const same = projects.filter((project) => project.title.toLowerCase() === title);
      if (same.length === 1) return same[0];
    }
    // The only project stands in only when no project was asked for: a project named here or a
    // channel default that is gone must match (by id, answer, repository, or title), or the
    // requester is asked. An answer alone may be about something else, such as the machine.
    const askedForOne =
      hint.requireNamed === true ||
      hint.projectId !== undefined ||
      hint.localTitle !== undefined ||
      hint.canonicalKey !== undefined;
    return projects.length === 1 && !askedForOne ? projects[0] : undefined;
  };

  /**
   * The account to run a model on over there, with the reason for the chip. Another account of
   * the same provider that offers the model can take the work when it has more quota left; the
   * configured account wins ties. Quotas come from that machine's goat_host_status; when it cannot
   * say, the configured account runs as before.
   */
  const placeOnHost = (
    host: string,
    selection: ModelSelection,
    offered: OfferedProviders | undefined,
    authorize: Effect.Effect<RuntimeMode, Superseded>,
  ) =>
    Effect.gen(function* () {
      const providers = offered?.providers ?? [];
      const configured = providers.find(
        (provider) => provider.providerInstanceId === selection.instanceId,
      );
      if (configured === undefined) return { modelSelection: selection, reason: undefined };
      const candidates = providers.filter(
        (provider) =>
          provider === configured ||
          (configured.driverKind !== undefined &&
            provider.driverKind === configured.driverKind &&
            provider.canRunChildTask === true &&
            provider.models.some((entry) => entry.id === selection.model)),
      );
      const status = yield* callHost(
        {
          host,
          tool: "goat_host_status",
          arguments: { local: true },
          writes: false,
          timeoutMs: READ_TIMEOUT_MS,
        },
        authorize,
      ).pipe(Effect.flatMap(decodeHostQuotas), Effect.option);
      const quotas = new Map(
        (status._tag === "Some" ? (status.value.hosts[0]?.metrics?.quotas ?? []) : []).map(
          (quota) => [quota.instanceId, quota.limits.windows] as const,
        ),
      );
      const placed = choosePlacement(
        candidates.map((provider) => {
          const windows = quotas.get(provider.providerInstanceId) ?? [];
          return {
            value:
              provider === configured
                ? selection
                : {
                    ...selection,
                    instanceId: ProviderInstanceId.make(provider.providerInstanceId),
                  },
            // Every candidate is on this host and the chip already names it.
            host: null,
            providerLabel: provider.displayName ?? provider.providerInstanceId,
            preferred: provider === configured,
            windows: windows.length === 0 ? null : windows,
            activeTasks: 0,
          };
        }),
        DateTime.toEpochMillis(yield* DateTime.now),
      );
      return { modelSelection: placed?.chosen.value ?? selection, reason: placed?.reason };
    });

  const resolve: ChannelRemoteWorkers["Service"]["resolve"] = (stored, local, owner) =>
    Effect.gen(function* () {
      const task = stored.task;
      const host = task.host;
      if (host === undefined) return { type: "local" } as const;
      const hosts = yield* knownHosts;
      if (!hosts.includes(host)) {
        return { type: "question", text: REMOTE_COPY.unknownHost(host, hosts) } as const;
      }
      // Only requesters with orchestration:operate create tasks (ChannelReceptionService), so
      // the scope is already checked; the remote enforces their runtime-mode ceiling.
      const authorize = Effect.succeed(task.requester.runtimeModeCeiling);
      const listed = yield* listRemoteProjects(host, authorize).pipe(Effect.result);
      if (listed._tag === "Failure") {
        yield* Effect.logWarning("channel remote project list failed", {
          taskId: task.taskId,
          host,
          reason:
            listed.failure instanceof SshRemoteDispatch.SshRemoteDispatchError
              ? listed.failure.reason
              : "superseded",
        });
        return { type: "question", text: REMOTE_COPY.unreachable(host) } as const;
      }
      const projects = listed.success;
      if (projects.length === 0) {
        return { type: "question", text: REMOTE_COPY.noProject(host) } as const;
      }
      const latest = (yield* ledger.recentAnswers(task.taskId, 1))[0];
      let choice = latest?.payload.projectChoice;
      if (latest !== undefined && choice === undefined) {
        const raw = latest.payload.answer;
        const answer = raw.toLowerCase();
        const named = projects
          .filter(
            (project) =>
              project.id === raw.trim() ||
              (project.title !== "" && answer.includes(project.title.toLowerCase())),
          )
          .toSorted((left, right) => right.title.length - left.title.length)[0];
        const localProject = (local.localProjects ?? []).find(
          (project) =>
            project.id === raw.trim() ||
            (project.title !== "" && answer.includes(project.title.toLowerCase())),
        );
        const namedHost = hosts
          .filter((alias) => answer.includes(alias.toLowerCase()))
          .toSorted((left, right) => right.length - left.length)[0];
        choice =
          named !== undefined
            ? { type: "remote", host, projectId: named.id }
            : localProject !== undefined
              ? { type: "local", projectId: ProjectId.make(localProject.id) }
              : meansThisMachine(raw)
                ? { type: "host", host: null }
                : namedHost !== undefined
                  ? { type: "host", host: namedHost }
                  : { type: "none" };
        yield* ledger.recordAnswerProjectChoice({ owner, eventId: latest.eventId, choice });
      }
      // Never reinterpret an older answer against today's catalog. An unresolved answer is
      // also a barrier: it might have named a project while that machine was unreachable.
      const remembered =
        choice?.type === "none" ? yield* ledger.rememberedProjectChoice(task.taskId) : choice;
      const remoteChoice = remembered?.type === "remote" ? remembered : undefined;
      const chosen =
        remoteChoice !== undefined
          ? remoteChoice.host === host
            ? projects.find((project) => project.id === remoteChoice.projectId)
            : undefined
          : chooseProject(projects, {
              ...(task.projectId === undefined ? {} : { projectId: task.projectId }),
              ...(local.title === undefined ? {} : { localTitle: local.title }),
              ...(local.canonicalKey === undefined ? {} : { canonicalKey: local.canonicalKey }),
              ...(local.requireNamedProject === true ? { requireNamed: true } : {}),
            });
      if (chosen === undefined) {
        return {
          type: "question",
          text: REMOTE_COPY.whichProject(
            host,
            projects.map((project) => project.title),
          ),
        } as const;
      }
      const environment = yield* callHost(
        {
          host,
          tool: "goat_environment_read",
          arguments: {},
          writes: false,
          timeoutMs: READ_TIMEOUT_MS,
        },
        authorize,
      ).pipe(Effect.flatMap(decodeEnvironment), Effect.result);
      if (environment._tag === "Failure") {
        return { type: "question", text: REMOTE_COPY.unreachable(host) } as const;
      }
      const fallbackModel = chosen.defaultModelSelection ?? local.modelSelection;
      // Check the model before launching: the remote's refusal would not say why.
      const capabilities = yield* callHost(
        {
          host,
          tool: "orchestrator_capabilities",
          arguments: {},
          writes: false,
          timeoutMs: READ_TIMEOUT_MS,
        },
        authorize,
      ).pipe(Effect.flatMap(decodeOffered), Effect.result);
      // Unreachable now: ask, as when the project list cannot be read.
      if (capabilities._tag === "Failure" && isUnreachable(capabilities.failure)) {
        return { type: "question", text: REMOTE_COPY.unreachable(host) } as const;
      }
      // A machine that answers but cannot list its models (an older GOAT) cannot confirm a
      // preference, so only the project's own model runs there and the launch decides.
      const offered = capabilities._tag === "Success" ? capabilities.success : undefined;
      const isOffered = (model: ModelSelection) =>
        offered !== undefined &&
        offered.providers.some(
          (provider) =>
            provider.providerInstanceId === model.instanceId &&
            provider.models.some((entry) => entry.id === model.model),
        );
      const preferred = local.preferredModelSelection;
      // A Slack connection's model is a preference, as on this machine: when that machine does
      // not offer it, or cannot say, the project's model runs the work instead of a question
      // nobody can act on.
      const usePreferred = preferred !== undefined && isOffered(preferred);
      if (preferred !== undefined && !usePreferred) {
        yield* Effect.logWarning("channel default model not offered on the other machine", {
          taskId: task.taskId,
          host,
          checked: offered !== undefined,
        });
      }
      const modelSelection = usePreferred ? preferred : fallbackModel;
      if (offered !== undefined && !isOffered(modelSelection)) {
        return {
          type: "question",
          text:
            chosen.defaultModelSelection !== undefined && chosen.defaultModelSelection !== null
              ? REMOTE_COPY.projectModelMissing(host, chosen.title)
              : REMOTE_COPY.defaultModelMissing(host, chosen.title),
        } as const;
      }
      const placed = yield* placeOnHost(host, modelSelection, offered, authorize);
      const target: ChannelDispatchTarget = {
        environmentId: environment.success.environmentId,
        projectId: chosen.id,
        modelSelection: placed.modelSelection,
        runtimeMode: local.runtimeMode,
        interactionMode: "default",
        // A repository gets its own worktree per task, as on this machine.
        workspaceStrategy:
          chosen.repositoryIdentity !== undefined && chosen.repositoryIdentity !== null
            ? { type: "worktree" }
            : { type: "root" },
        remote: { host, cwd: chosen.workspaceRoot },
        ...(placed.reason === undefined ? {} : { placementReason: placed.reason }),
        ...(local.memoryGrantCeiling === undefined || local.memoryGrantCeiling === "none"
          ? {}
          : { memoryGrantCeiling: local.memoryGrantCeiling }),
      };
      return { type: "target", target } as const;
    });

  /**
   * The worker's first message. GOAT Bot's notes and the skills the instruction names exist only
   * on this machine, so they are read now and travel inside the message.
   */
  const workerMessage = (task: ChannelLedger.ChannelStoredTask["task"]) =>
    Effect.gen(function* () {
      const notes = yield* readChannelBotNotes(fileSystem, botFiles);
      const skills = yield* readNamedSkills(fileSystem, path, botFiles, task.instruction);
      return remoteWorkerMessage(task, { notes, skills });
    });

  /** Binds the task to the remote thread the launch (or its recovery) found. */
  const bindWorker = (
    owner: string,
    stored: ChannelLedger.ChannelStoredTask,
    state: RemoteWorkerState,
    threadId: string,
    runId: string | null,
  ) =>
    Effect.gen(function* () {
      const target = stored.task.target;
      if (target === undefined || stored.task.status !== "dispatching") return;
      yield* commitTransition(
        ledger,
        stored,
        {
          type: "task.worker.bound",
          payload: {
            worker: {
              environmentId: target.environmentId,
              threadId: ThreadId.make(threadId),
              ...(runId === null ? {} : { runId: RunId.make(runId) }),
              generation: stored.task.generation,
              host: state.host,
            },
          },
        },
        {
          owner,
          remoteWorker: stateUpdate(stored.task.taskId, state.generation, (current) => ({
            ...current,
            remoteThreadId: threadId,
          })),
        },
      );
    });

  const failTask = (
    owner: string,
    stored: ChannelLedger.ChannelStoredTask,
    reason: string,
    summary: string,
  ) =>
    commitTransition(
      ledger,
      stored,
      {
        type: "task.failed",
        payload: { generation: stored.task.generation, reason, summary },
      },
      { owner, narrate: true },
    ).pipe(Effect.asVoid);

  const askAgain = (
    owner: string,
    stored: ChannelLedger.ChannelStoredTask,
    text: string,
    options: { readonly clearPendingAnswer?: boolean } = {},
  ) =>
    Effect.gen(function* () {
      const askedAt = yield* nowIso;
      yield* commitTransition(
        ledger,
        stored,
        {
          type: "task.question.opened",
          payload: {
            question: {
              questionId: questionIdFor(stored.task.taskId, stored.task.version + 1),
              text,
              askedAt,
              ...(stored.task.requester.externalActorId === undefined
                ? {}
                : { requesterExternalActorId: stored.task.requester.externalActorId }),
            },
          },
        },
        {
          owner,
          narrate: true,
          ...(options.clearPendingAnswer ? { pendingAnswerMessageId: null } : {}),
        },
      );
    });

  /** One look at the report binding without waiting; tells whether the launch happened. */
  const probe = (state: RemoteWorkerState, authorize: Effect.Effect<RuntimeMode, Superseded>) =>
    callHost(
      {
        host: state.host,
        tool: "goat_origin_reports_wait",
        arguments: {
          correlationId: state.correlationId,
          readKey: state.readKey,
          afterSequence: state.cursor,
          watchRunId: null,
          knownRun: null,
          timeoutMs: 0,
        },
        writes: false,
        timeoutMs: READ_TIMEOUT_MS,
      },
      authorize,
    ).pipe(Effect.flatMap(decodeWait));

  const remoteCode = (error: unknown) =>
    error instanceof SshRemoteDispatch.SshRemoteDispatchError ? error.remoteCode : undefined;
  const isUnreachable = (error: unknown) =>
    error instanceof SshRemoteDispatch.SshRemoteDispatchError &&
    (error.reason === "host_unavailable" || error.reason === "ssh_failed");

  /**
   * Launch, or find what an earlier launch of this generation started. Never starts a second
   * remote thread: the binding id is fixed per generation and the remote refuses a duplicate.
   */
  const launchOnce = (taskId: ChannelTaskId, owner: string) =>
    Effect.gen(function* () {
      let stored = yield* ledger.getTask(taskId);
      if (stored === undefined || stored.task.status !== "dispatching") return;
      const task = stored.task;
      const remote = task.target?.remote;
      if (remote === undefined) return;
      const now = yield* nowIso;
      let state = yield* readState(taskId);
      const moved =
        state !== undefined &&
        state.generation === task.generation &&
        (state.host !== remote.host || state.cwd !== remote.cwd);
      if (moved && state!.attempts > 0) {
        // The first destination may already run it; a new destination needs a new generation.
        return yield* failTask(
          owner,
          stored,
          "launch_uncertain",
          REMOTE_COPY.launchUncertain(state!.host),
        );
      }
      if (state === undefined || state.generation !== task.generation || moved) {
        const fresh: RemoteWorkerState = {
          generation: task.generation,
          host: remote.host,
          cwd: remote.cwd,
          correlationId: remoteCorrelationFor(taskId, task.generation),
          readKey: NodeCrypto.randomBytes(32).toString("hex"),
          launchStartedAt: now,
          attempts: 0,
          cursor: 0,
          inbox: [],
          dropped: 0,
          forwarded: [],
          outageNoticed: false,
        };
        const json = yield* ledger.updateRemoteWorker({
          owner,
          now,
          update: { taskId, update: () => encodeState(fresh) },
        });
        state = decodeState(json);
        if (state === undefined) return;
      }
      const authorize = authorityFor(taskId, task.generation, owner);
      const elapsed = Date.parse(now) - Date.parse(state.launchStartedAt);

      if (state.attempts > 0) {
        // An earlier attempt may have started the thread: look before launching again.
        const seen = yield* probe(state, authorize).pipe(Effect.result);
        if (seen._tag === "Success") {
          return yield* bindWorker(
            owner,
            stored,
            state,
            seen.success.threadId,
            seen.success.latestRunId,
          );
        }
        const code = remoteCode(seen.failure);
        if (seen.failure instanceof Superseded) return;
        if (code === "thread_not_found" || isUnreachable(seen.failure)) {
          // The binding exists but its thread is not visible yet, or the host is away.
          if (elapsed > LAUNCH_GRACE_MS) {
            yield* failTask(
              owner,
              stored,
              "launch_uncertain",
              REMOTE_COPY.launchUncertain(state.host),
            );
          }
          return;
        }
        if (code !== "capability_denied") return;
        // No binding we can reach. Launching again is safe either way: the remote refuses a
        // second binding with this id, so it can never start a second thread.
      }
      if (state.attempts >= MAX_LAUNCH_ATTEMPTS) {
        return yield* failTask(
          owner,
          stored,
          "launch_uncertain",
          REMOTE_COPY.launchUncertain(state.host),
        );
      }

      // The project may have gone since the dispatcher chose it; ask instead of recreating it.
      const listed = yield* listRemoteProjects(state.host, authorize).pipe(Effect.result);
      if (listed._tag === "Failure") return;
      if (!listed.success.some((project) => project.workspaceRoot === remote.cwd)) {
        return yield* askAgain(owner, stored, REMOTE_COPY.projectGone(state.host));
      }

      state = yield* writeState(owner, taskId, task.generation, (current) => ({
        ...current,
        attempts: current.attempts + 1,
      }));
      if (state === undefined) return;
      const target = task.target!;
      const readKeyHash = NodeCrypto.createHash("sha256").update(state.readKey).digest("hex");
      const bot = yield* ledger.getBot(stored.ownerId);
      const message = yield* workerMessage(task);
      // SSH's extra reporting note is transport guidance, excluded from deliveredText.
      // The notes travel inside the message unless they were dropped to fit its limit.
      const notesRevision =
        stored.task.briefVersion === undefined && message.includes("<goat_bot_notes>")
          ? yield* channelNotesRevision(botFiles.notes).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
            )
          : null;
      const frozen = yield* freezeChannelBrief(ledger, stored, owner, message, { notesRevision });
      stored = frozen.stored;
      const launched = yield* ssh
        .launchThread(
          {
            host: state.host,
            cwd: remote.cwd,
            workspace:
              target.workspaceStrategy.type === "worktree"
                ? {
                    type: "worktree",
                    branch: remoteBranchFor(taskId, task.generation),
                    ...(target.workspaceStrategy.baseRef === undefined
                      ? {}
                      : { baseRef: target.workspaceStrategy.baseRef }),
                  }
                : { type: "cwd" },
            title: task.title,
            message: frozen.brief.deliveredText,
            modelSelection: target.modelSelection,
            runtimeMode: target.runtimeMode,
            // The remote session may grant no more than the person who asked.
            callerRuntimeMode: task.requester.runtimeModeCeiling,
            // Omitted when none: an older remote refuses any ceiling it cannot verify.
            ...(target.memoryGrantCeiling === undefined
              ? {}
              : { memoryGrantCeiling: target.memoryGrantCeiling }),
            interactionMode: target.interactionMode,
            report: {
              correlationId: state.correlationId,
              originLabel: NodeOS.hostname().slice(0, 120) || "GOAT",
              originThreadId: bot?.bot.threadId ?? ThreadId.make("channel-task:" + taskId),
              readKeyHash,
            },
            reportNote: REPORTING_NOTE,
          },
          authorize.pipe(Effect.asVoid),
        )
        .pipe(Effect.result);
      if (launched._tag === "Success") {
        if (!launched.success.reportsSupported) {
          return yield* failTask(
            owner,
            stored,
            "reports_unsupported",
            REMOTE_COPY.reportsUnsupported(state.host),
          );
        }
        return yield* bindWorker(
          owner,
          stored,
          state,
          launched.success.threadId,
          launched.success.runId,
        );
      }
      const error = launched.failure;
      if (!(error instanceof SshRemoteDispatch.SshRemoteDispatchError)) return;
      yield* Effect.logWarning("channel remote launch failed", {
        taskId,
        host: state.host,
        reason: error.reason,
      });
      if (
        isUnreachable(error) ||
        error.launchMayHaveStarted === true ||
        error.reason === "caller_changed"
      ) {
        return; // the next pass looks for the thread before trying again
      }
      // A refusal may be the remote refusing a duplicate binding: look before failing. Only a
      // binding we cannot reach makes the refusal definite; anything else is looked at again on
      // the next pass, under the same grace as a lost launch answer.
      const seen = yield* probe(state, authorize).pipe(Effect.result);
      if (seen._tag === "Success") {
        return yield* bindWorker(
          owner,
          stored,
          state,
          seen.success.threadId,
          seen.success.latestRunId,
        );
      }
      // An older remote that cannot apply the task's memory grant refused before launching.
      // Running without the grant would silently drop it, so the task fails and says why.
      if (remoteCode(error) === SshRemoteDispatch.MEMORY_CEILING_UNSUPPORTED) {
        return yield* failTask(
          owner,
          stored,
          "memory_unsupported",
          REMOTE_COPY.memoryUnsupported(state.host),
        );
      }
      if (remoteCode(seen.failure) !== "capability_denied") return;
      yield* failTask(owner, stored, "launch_refused", REMOTE_COPY.launchRefused(state.host));
    });

  type Stored = ChannelLedger.ChannelStoredTask;

  /** The task still runs this generation on this host and thread. */
  const sameWorker = (stored: Stored | undefined, state: RemoteWorkerState) =>
    stored !== undefined &&
    (stored.task.status === "running" || stored.task.status === "waiting_input") &&
    stored.task.generation === state.generation &&
    stored.task.worker?.host === state.host &&
    stored.task.worker.threadId === state.remoteThreadId;

  /** The binding an observer follows; answers for any other binding are stale. */
  interface Followed {
    readonly generation: number;
    readonly correlationId: string;
    readonly remoteThreadId: string;
  }

  /** The current state and task, if they still belong to the binding the observer follows. */
  const followedNow = (taskId: ChannelTaskId, followed: Followed) =>
    Effect.gen(function* () {
      const state = yield* readState(taskId);
      const stored = yield* ledger.getTask(taskId);
      if (
        state === undefined ||
        stored === undefined ||
        state.correlationId !== followed.correlationId ||
        state.generation !== followed.generation ||
        state.remoteThreadId !== followed.remoteThreadId ||
        !sameWorker(stored, state)
      ) {
        return undefined;
      }
      return { state, stored };
    });

  /** One report becomes at most one event, committed with its removal from the inbox. */
  const importReport = (
    owner: string,
    stored: Stored,
    state: RemoteWorkerState,
    report: RemoteReport,
  ) =>
    Effect.gen(function* () {
      const task = stored.task;
      const eventId = remoteReportEventIdFor(
        state.correlationId,
        report.sequence,
      ) as ChannelTaskEventId;
      const removal = stateUpdate(task.taskId, state.generation, (current) => ({
        ...current,
        inbox: current.inbox.filter((entry) => entry.sequence !== report.sequence),
      }));
      const current = task.worker?.runId;
      const fromOlderRun = report.runId !== null && report.runId !== current;
      const summary = report.summary.trim();
      let spec: ChannelTaskEventSpec | undefined;
      let narrate = false;
      if (!(yield* ledger.hasTaskEvent(eventId)) && summary !== "") {
        switch (report.kind) {
          case "progress":
            if (task.status === "running") {
              spec = { type: "task.progress", payload: { generation: task.generation, summary } };
            }
            break;
          case "needs_input":
            if (!fromOlderRun && task.status === "running") {
              narrate = true;
              spec = {
                type: "task.question.opened",
                payload: {
                  question: {
                    questionId: questionIdFor(task.taskId, task.version + 1),
                    text: summary,
                    askedAt: report.createdAt,
                    ...(task.requester.externalActorId === undefined
                      ? {}
                      : { requesterExternalActorId: task.requester.externalActorId }),
                  },
                },
              };
            }
            break;
          case "completed":
            if (!fromOlderRun && task.status === "running" && current !== undefined) {
              spec = {
                type: "task.completion.proposed",
                payload: {
                  proposal: { eventId, generation: task.generation, runId: current, summary },
                },
              };
            }
            break;
          case "failed":
            if (!fromOlderRun) {
              narrate = true;
              spec = {
                type: "task.failed",
                payload: { generation: task.generation, reason: "reported_failed", summary },
              };
            }
            break;
        }
      }
      if (spec !== undefined) {
        const next = yield* commitTransition(ledger, stored, spec, {
          owner,
          actor: "agent",
          eventId,
          narrate,
          remoteWorker: removal,
          ...(spec.type === "task.failed" ? { completionHold: null } : {}),
        });
        if (next !== undefined) return;
      }
      // Already imported, from an older run, or not allowed in this state: drop it on purpose.
      yield* ledger.updateRemoteWorker({ owner, now: yield* nowIso, update: removal });
    });

  /** Applies one wait answer. Returns whether to keep observing and how soon to look again. */
  const reduce = (
    owner: string,
    taskId: ChannelTaskId,
    followed: Followed,
    answer: RemoteOriginReportsWaitResult,
  ) =>
    Effect.gen(function* () {
      const now = yield* followedNow(taskId, followed);
      // An answer for a binding the task no longer follows (a retry, a new owner) changes nothing.
      if (now === undefined) return "stop" as const;
      let state: RemoteWorkerState | undefined = now.state;
      let stored: Stored | undefined = now.stored;
      if (answer.threadId !== followed.remoteThreadId) {
        yield* failTask(owner, stored, "remote_lost", REMOTE_COPY.lost(state.host));
        return "stop" as const;
      }

      // 1. New reports go to the local inbox with the cursor, so the remote may drop them.
      const fresh = answer.reports.filter((report) => report.sequence > state!.cursor);
      const watched = answer.observedRun;
      state = yield* writeState(owner, taskId, state.generation, (current) => {
        const merged = [
          ...current.inbox,
          ...fresh.filter((report) => report.sequence > current.cursor),
        ];
        const overflow = Math.max(0, merged.length - INBOX_LIMIT);
        const kept = overflow === 0 ? merged : dropOldest(merged, overflow);
        return {
          ...current,
          inbox: kept,
          dropped: current.dropped + (merged.length - kept.length),
          cursor: Math.max(current.cursor, ...fresh.map((report) => report.sequence)),
          ...(watched === null
            ? {}
            : {
                knownRun: {
                  runId: watched.runId,
                  status: watched.status,
                  ...(watched.holds === undefined ? {} : { holds: watched.holds }),
                  ...(watched.pendingRequestIds === undefined
                    ? {}
                    : { pendingRequestIds: watched.pendingRequestIds }),
                  ...(watched.observation === undefined
                    ? {}
                    : { observation: watched.observation }),
                },
              }),
        };
      });
      if (state === undefined) return "stop" as const;

      // 2. A sent answer: wait for the remote to show its run, then follow the newest run.
      stored = yield* ledger.getTask(taskId);
      if (stored === undefined || !sameWorker(stored, state)) return "stop" as const;
      const answerPending = stored.pendingAnswerMessageId !== undefined;
      if (answerPending) {
        const receipt = state.receipt;
        if (receipt === undefined || watched?.runId !== receipt.runId) {
          return answer.hasMore ? ("now" as const) : ("wait" as const);
        }
      }
      const latest = answer.latestRunId;
      if (
        stored.task.status === "running" &&
        latest !== null &&
        (latest !== stored.task.worker?.runId || answerPending)
      ) {
        yield* commitTransition(
          ledger,
          stored,
          {
            type: "task.worker.bound",
            payload: { worker: { ...stored.task.worker!, runId: latest } },
          },
          {
            owner,
            ...(answerPending ? { pendingAnswerMessageId: null } : {}),
            remoteWorker: stateUpdate(taskId, state.generation, (current) => {
              const { receipt: _receipt, settleRunId: _settle, ...rest } = current;
              return rest;
            }),
          },
        );
        state = yield* readState(taskId);
        if (state === undefined) return "stop" as const;
      }

      // The remote worker's pull requests, native requests and usage-limit wait, for the current
      // run only. An older remote sends none, and the task shows nothing extra.
      stored = yield* ledger.getTask(taskId);
      if (stored === undefined || !sameWorker(stored, state)) return "stop" as const;
      const observation = watched?.observation;
      if (
        observation !== undefined &&
        watched !== null &&
        watched.runId === stored.task.worker?.runId &&
        (stored.task.status === "running" || stored.task.status === "waiting_input") &&
        !channelWorkerObservationEquals(stored.task.observed, observation)
      ) {
        yield* commitTransition(
          ledger,
          stored,
          {
            type: "task.worker.observed",
            payload: { generation: stored.task.generation, observed: observation },
          },
          { owner },
        );
      }
      // A usage limit pauses the worker; the continuation run the remote starts rebinds the task.
      const limited =
        watched !== null && watched.status === "failed" && observesUsageLimit(observation);

      // 3. The inbox, oldest first, against the current run.
      if (state.dropped > 0) {
        stored = yield* ledger.getTask(taskId);
        if (stored !== undefined && stored.task.status === "running") {
          yield* commitTransition(
            ledger,
            stored,
            {
              type: "task.progress",
              payload: {
                generation: stored.task.generation,
                summary: REMOTE_COPY.inboxOverflow(state.dropped),
              },
            },
            {
              owner,
              remoteWorker: stateUpdate(taskId, state.generation, (current) => ({
                ...current,
                dropped: 0,
              })),
            },
          );
        } else {
          yield* writeState(owner, taskId, state.generation, (current) => ({
            ...current,
            dropped: 0,
          }));
        }
      }
      const imported = state.inbox.length > 0;
      for (const report of state.inbox) {
        stored = yield* ledger.getTask(taskId);
        if (stored === undefined || !sameWorker(stored, state)) return "stop" as const;
        yield* importReport(owner, stored, state, report);
      }
      if (answer.hasMore) return "now" as const;

      // 4. Settlement: a finished current run, seen twice with nothing newer in between.
      stored = yield* ledger.getTask(taskId);
      state = yield* readState(taskId);
      if (stored === undefined || state === undefined || !sameWorker(stored, state)) {
        return "stop" as const;
      }
      const runId = stored.task.worker?.runId;
      // A worker that asked and then failed or was stopped ends the task, as on this machine.
      if (
        stored.task.status === "waiting_input" &&
        stored.pendingAnswerMessageId === undefined &&
        runId !== undefined &&
        watched !== null &&
        watched.runId === runId &&
        latest === runId &&
        TERMINAL.has(watched.status) &&
        watched.status !== "completed" &&
        !limited
      ) {
        yield* commitTransition(
          ledger,
          stored,
          watched.status === "cancelled"
            ? { type: "task.cancelled", payload: { reason: "The coding thread was stopped." } }
            : {
                type: "task.failed",
                payload: {
                  generation: stored.task.generation,
                  reason: watched.status,
                  summary:
                    "The coding thread ended with " + watched.status.replaceAll("_", " ") + ".",
                },
              },
          { owner, narrate: true, completionHold: null },
        );
        return "stop" as const;
      }
      const settles =
        stored.task.status === "running" &&
        stored.task.openQuestions.length === 0 &&
        stored.pendingAnswerMessageId === undefined &&
        runId !== undefined &&
        watched !== null &&
        watched.runId === runId &&
        latest === runId &&
        TERMINAL.has(watched.status) &&
        !limited;
      if (!settles) {
        if (state.settleRunId !== undefined) {
          yield* writeState(
            owner,
            taskId,
            state.generation,
            ({ settleRunId: _s, ...rest }) => rest,
          );
        }
        if (
          runId === undefined &&
          latest === null &&
          Date.parse(yield* nowIso) - Date.parse(state.launchStartedAt) > LAUNCH_GRACE_MS
        ) {
          yield* failTask(
            owner,
            stored,
            "launch_incomplete",
            REMOTE_COPY.launchIncomplete(state.host),
          );
          return "stop" as const;
        }
        return "wait" as const;
      }
      // As on this machine, a continuation still to come or background work left after a
      // completed run keeps the task open. An older remote does not say, and the grace below
      // stands in for it.
      const holds = watched.holds;
      const backgroundPending =
        watched.status === "completed" && holds !== undefined && holds.backgroundTasks > 0;
      if (holds?.continuationPending === true || backgroundPending) {
        if (backgroundPending && stored.completionHold !== BACKGROUND_HOLD) {
          yield* ledger.setCompletionHold({ owner, taskId, hold: BACKGROUND_HOLD });
        }
        if (state.settleRunId !== undefined) {
          yield* writeState(
            owner,
            taskId,
            state.generation,
            ({ settleRunId: _s, ...rest }) => rest,
          );
        }
        return "wait" as const;
      }
      if (state.settleRunId !== runId || imported) {
        yield* writeState(owner, taskId, state.generation, (current) => ({
          ...current,
          settleRunId: runId,
        }));
        return "settle" as const;
      }
      if (watched.status === "completed") {
        const proposal = stored.task.proposedCompletion;
        const fallbackSummary =
          watched.summary?.trim() ||
          (proposal?.runId === runId ? proposal.summary : undefined) ||
          "Finished.";
        // An older remote sends no report, which settles as before with report "missing".
        yield* commitTransition(
          ledger,
          stored,
          settleCompletedRun({
            task: stored.task,
            runId,
            reported: watched.reported,
            fallbackSummary,
            now: yield* nowIso,
          }),
          { owner, narrate: true, completionHold: null },
        );
      } else if (watched.status === "cancelled") {
        yield* commitTransition(
          ledger,
          stored,
          { type: "task.cancelled", payload: { reason: "The coding thread was stopped." } },
          { owner, narrate: true, completionHold: null },
        );
      } else {
        yield* commitTransition(
          ledger,
          stored,
          {
            type: "task.failed",
            payload: {
              generation: stored.task.generation,
              reason: watched.status,
              summary: "The coding thread ended with " + watched.status.replaceAll("_", " ") + ".",
            },
          },
          { owner, narrate: true, completionHold: null },
        );
      }
      return "stop" as const;
    });

  /** One observer: long-polls the binding until the task settles, moves on, or ownership goes. */
  const observe = (taskId: ChannelTaskId, generation: number, owner: string) =>
    Effect.gen(function* () {
      let backoff = BACKOFF_START_MS;
      let failures = 0;
      let mode: "wait" | "now" | "settle" = "wait";
      while (true) {
        if (!(yield* ledger.isOwner(owner))) return;
        const state = yield* readState(taskId);
        const stored = yield* ledger.getTask(taskId);
        if (state === undefined || !sameWorker(stored, state)) return;
        if (state.generation !== generation) return;
        const followed: Followed = {
          generation: state.generation,
          correlationId: state.correlationId,
          remoteThreadId: state.remoteThreadId!,
        };
        const waitMs: number =
          mode === "settle" ? REMOTE_SETTLE_WAIT_MS : mode === "now" ? 0 : REMOTE_WAIT_MS;
        const answer: Result.Result<
          RemoteOriginReportsWaitResult,
          SshRemoteDispatch.SshRemoteDispatchError | Superseded | Schema.SchemaError
        > = yield* callHost(
          {
            host: state.host,
            tool: "goat_origin_reports_wait",
            arguments: {
              correlationId: state.correlationId,
              readKey: state.readKey,
              afterSequence: state.cursor,
              watchRunId:
                stored!.pendingAnswerMessageId !== undefined && state.receipt !== undefined
                  ? state.receipt.runId
                  : null,
              knownRun: state.knownRun ?? null,
              timeoutMs: waitMs,
            },
            writes: false,
            timeoutMs: waitMs + TRANSPORT_HEADROOM_MS,
          },
          authorityFor(taskId, state.generation, owner),
        ).pipe(Effect.flatMap(decodeWait), Effect.result);
        if (answer._tag === "Success") {
          failures = 0;
          backoff = BACKOFF_START_MS;
          if (state.outageNoticed) yield* noticeOutage(owner, taskId, followed, false);
          const next: "stop" | "wait" | "now" | "settle" = yield* serialized(taskId)(
            reduce(owner, taskId, followed, answer.success),
          );
          if (next === "stop") return;
          mode = next;
          continue;
        }
        const error = answer.failure;
        if (error instanceof Superseded) return;
        const code = remoteCode(error);
        if (code === "run_not_found" && state.receipt !== undefined) {
          // The answer's run is gone: forget the receipt and follow the newest run.
          yield* serialized(taskId)(
            Effect.gen(function* () {
              const now = yield* followedNow(taskId, followed);
              if (now === undefined) return;
              const forget = stateUpdate(
                taskId,
                followed.generation,
                ({ receipt: _r, ...rest }) => rest,
              );
              if (
                now.stored.pendingAnswerMessageId !== undefined &&
                now.stored.task.status === "running"
              ) {
                const next = yield* commitTransition(
                  ledger,
                  now.stored,
                  { type: "task.worker.bound", payload: { worker: now.stored.task.worker! } },
                  { owner, pendingAnswerMessageId: null, remoteWorker: forget },
                );
                if (next !== undefined) return;
              }
              yield* ledger.updateRemoteWorker({ owner, now: yield* nowIso, update: forget });
            }),
          );
          mode = "now";
          continue;
        }
        if (code === "thread_not_found" || code === "capability_denied") {
          yield* serialized(taskId)(
            Effect.gen(function* () {
              const now = yield* followedNow(taskId, followed);
              if (now !== undefined) {
                yield* failTask(owner, now.stored, "remote_lost", REMOTE_COPY.lost(now.state.host));
              }
            }),
          );
          return;
        }
        failures += isUnreachable(error) ? 1 : 0;
        yield* Effect.logWarning("channel remote observation failed; retrying", {
          taskId,
          host: state.host,
          reason: error._tag === "SshRemoteDispatchError" ? error.reason : "decode",
        });
        if (failures >= OUTAGE_NOTICE_AFTER && !state.outageNoticed) {
          yield* noticeOutage(owner, taskId, followed, true);
        }
        yield* Effect.sleep(Duration.millis(backoff));
        backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
        mode = "wait";
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("channel remote observer stopped", { taskId, failure: causeTag(cause) }),
      ),
    );

  /** Tells the requester once per outage, with the flag in the same write. */
  const noticeOutage = (owner: string, taskId: ChannelTaskId, followed: Followed, down: boolean) =>
    serialized(taskId)(
      Effect.gen(function* () {
        const now = yield* followedNow(taskId, followed);
        if (now === undefined || now.state.outageNoticed === down) return;
        const { state, stored } = now;
        const flag = stateUpdate(taskId, state.generation, (current) => ({
          ...current,
          outageNoticed: down,
        }));
        if (stored.task.status === "running") {
          const next = yield* commitTransition(
            ledger,
            stored,
            {
              type: "task.progress",
              payload: {
                generation: stored.task.generation,
                summary: down
                  ? REMOTE_COPY.outage(state.host)
                  : REMOTE_COPY.reconnected(state.host),
              },
            },
            { owner, remoteWorker: flag },
          );
          if (next !== undefined) return;
        }
        yield* ledger.updateRemoteWorker({ owner, now: yield* nowIso, update: flag });
      }),
    );

  const observerKey = (taskId: ChannelTaskId, generation: number) =>
    "observe:" + taskId + ":" + generation;

  const background = <E>(key: string, effect: Effect.Effect<void, E>) =>
    FiberMap.run(
      fibers,
      key,
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("channel remote work failed", { key, failure: causeTag(cause) }),
        ),
      ),
      { onlyIfMissing: true },
    ).pipe(Effect.asVoid);

  const launch: ChannelRemoteWorkers["Service"]["launch"] = (taskId, owner) =>
    background("launch:" + taskId, launchAndObserve(taskId, owner));

  const launchAndObserve = (taskId: ChannelTaskId, owner: string) =>
    serialized(taskId)(launchOnce(taskId, owner)).pipe(
      Effect.andThen(
        ledger
          .getTask(taskId)
          .pipe(
            Effect.flatMap((stored) =>
              stored?.task.status === "running" && stored.task.worker?.host !== undefined
                ? background(
                    observerKey(taskId, stored.task.generation),
                    observe(taskId, stored.task.generation, owner),
                  )
                : Effect.void,
            ),
          ),
      ),
    );

  const dispatch: ChannelRemoteWorkers["Service"]["dispatch"] = (taskId, owner, local) =>
    background(
      "launch:" + taskId,
      Effect.gen(function* () {
        const stored = yield* ledger.getTask(taskId);
        if (stored === undefined || stored.task.status !== "received") return;
        const resolved = yield* resolve(stored, local, owner);
        if (resolved.type === "local" || resolved.type === "retry") return;
        if (!(yield* ledger.isOwner(owner))) return;
        const reread = yield* ledger.getTask(taskId);
        if (reread === undefined || reread.task.version !== stored.task.version) return;
        if (resolved.type === "question") return yield* askAgain(owner, reread, resolved.text);
        const claimedAt = yield* nowIso;
        const claimed = yield* commitTransition(
          ledger,
          reread,
          {
            type: "task.dispatch.claimed",
            payload: {
              generation: reread.task.generation,
              target: resolved.target,
              leaseExpiresAt: claimedAt,
            },
          },
          { owner },
        );
        if (claimed !== undefined) yield* launchAndObserve(taskId, owner);
      }),
    );

  const sendAnswer = (pending: ChannelLedger.ChannelPendingEvent, owner: string) =>
    Effect.gen(function* () {
      const event = pending.event;
      if (event.type !== "task.question.answered") {
        return yield* ledger.completeForward({ owner, sequence: pending.sequence });
      }
      const stored = yield* ledger.getTask(event.taskId);
      const worker = stored?.task.worker;
      const state = yield* readState(event.taskId);
      if (
        stored === undefined ||
        worker?.host === undefined ||
        state === undefined ||
        state.generation !== stored.task.generation ||
        state.remoteThreadId !== worker.threadId
      ) {
        return yield* ledger.completeForward({ owner, sequence: pending.sequence });
      }
      if (state.forwarded.includes(event.eventId)) {
        return yield* ledger.completeForward({ owner, sequence: pending.sequence });
      }
      const ids = answerForwardIdsFor(event.eventId);
      const sent = yield* callHost(
        {
          host: state.host,
          tool: "goat_thread_send",
          arguments: {
            threadId: worker.threadId,
            message:
              "Answer from " + stored.task.requester.displayName + ": " + event.payload.answer,
            mode: "queue",
            clientRequestId: ids.commandId,
          },
          writes: true,
          timeoutMs: SEND_TIMEOUT_MS,
        },
        authorityFor(stored.task.taskId, stored.task.generation, owner),
      ).pipe(Effect.flatMap(decodeSent), Effect.result);
      if (sent._tag === "Failure") {
        const code = remoteCode(sent.failure);
        if (
          code === "runtime_mode_escalation_denied" ||
          code === "interaction_mode_escalation_denied"
        ) {
          // The remote thread's modes went above the requester's ceiling: keep the answer's intent.
          yield* askAgain(
            owner,
            stored,
            REMOTE_COPY.answerRefused(state.host, event.payload.answer),
            { clearPendingAnswer: true },
          );
          return yield* ledger.completeForward({ owner, sequence: pending.sequence });
        }
        // Left pending; the next pass sends it again with the same request id.
        yield* Effect.logWarning("channel remote answer not sent", {
          taskId: stored.task.taskId,
          host: state.host,
          reason:
            sent.failure._tag === "SshRemoteDispatchError"
              ? sent.failure.reason
              : sent.failure._tag,
        });
        return;
      }
      yield* writeState(owner, stored.task.taskId, state.generation, (current) => ({
        ...current,
        receipt: {
          eventId: event.eventId,
          runId: sent.success.runId,
          messageId: sent.success.messageId,
        },
        forwarded: [...current.forwarded.slice(-19), event.eventId],
      }));
      yield* ledger.completeForward({ owner, sequence: pending.sequence });
    });

  const forward: ChannelRemoteWorkers["Service"]["forward"] = (pending, owner) =>
    background(
      "forward:" + pending.event.eventId,
      serialized(pending.event.taskId)(sendAnswer(pending, owner)),
    );

  const ensure: ChannelRemoteWorkers["Service"]["ensure"] = (owner) =>
    Effect.gen(function* () {
      let started = 0;
      for (const stored of yield* ledger.listTasksByStatus(["running", "waiting_input"])) {
        if (stored.task.worker?.host === undefined) continue;
        const key = observerKey(stored.task.taskId, stored.task.generation);
        if (yield* FiberMap.has(fibers, key)) continue;
        yield* background(key, observe(stored.task.taskId, stored.task.generation, owner));
        started += 1;
      }
      return started;
    });

  const attemptedElsewhere: ChannelRemoteWorkers["Service"]["attemptedElsewhere"] = (stored) =>
    Effect.gen(function* () {
      const state = yield* readState(stored.task.taskId);
      if (state === undefined || state.generation !== stored.task.generation) return undefined;
      if (state.attempts === 0) return undefined;
      const remote = stored.task.target?.remote;
      // The requested machine changed (to this one or another), or a claim points elsewhere.
      const moved =
        stored.task.host !== state.host ||
        (remote !== undefined && (remote.host !== state.host || remote.cwd !== state.cwd));
      return moved ? state.host : undefined;
    });

  return ChannelRemoteWorkers.of({
    knownHosts,
    resolve,
    launch,
    dispatch,
    forward,
    ensure,
    attemptedElsewhere,
  });
});

/** Progress goes first, then the oldest of the rest. */
const dropOldest = (reports: ReadonlyArray<RemoteReport>, count: number) => {
  const dropped = new Set<number>();
  for (const report of reports) {
    if (dropped.size >= count) break;
    if (report.kind === "progress") dropped.add(report.sequence);
  }
  for (const report of reports) {
    if (dropped.size >= count) break;
    dropped.add(report.sequence);
  }
  return reports.filter((report) => !dropped.has(report.sequence));
};

export const layer = Layer.effect(ChannelRemoteWorkers, make);
