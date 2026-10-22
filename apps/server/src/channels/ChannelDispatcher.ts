/**
 * ChannelDispatcher - the ledger's central decision maker.
 *
 * A deterministic service, not a hidden agent thread: it reads one task from the ledger, picks a
 * project and launch settings within what the requester may use, records that choice, and starts
 * one coding thread through the normal launch service. When the choice is ambiguous or not
 * allowed it asks the requester instead of guessing. It also forwards answers to worker threads.
 *
 * Launch ids derive from the task and its generation, so a restart re-runs the same launch and
 * lands on the same thread.
 *
 * @module ChannelDispatcher
 */
import {
  type ChannelDispatchTarget,
  type CommandId,
  type ChannelRequester,
  type ChannelTask,
  type ChannelTaskId,
  type MemoryTaskGrantCeiling,
  type ModelSelection,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProjectId,
  resolveProjectProviderInstanceEnabled,
} from "@goat/contracts";
import { resolveProjectSettings } from "@goat/shared/projectSettings";
import { prependStandingInstructions } from "@goat/shared/standingInstructions";
import { resolveGoatBotModelSelection } from "@goat/shared/serverSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FiberMap from "effect/FiberMap";
import * as Semaphore from "effect/Semaphore";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import {
  type DispatchModeRefusal,
  DispatchModeLimit,
} from "../orchestration-v2/DispatchModeLimit.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerConfig from "../config.ts";
import { captureMemoryGrantCeiling } from "../memory/MemoryAccess.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import {
  GOATCLAW_SUPERVISOR_ASKS,
  GOATCLAW_SUPERVISOR_DELEGATION,
  goatclawRoleTemplate,
} from "../goatclaw/RoleTemplates.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import { lowerRuntimeMode } from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRemoteWorkers from "./ChannelRemoteWorkers.ts";
import { makeChannelProjectChoices } from "./channelProjectChoices.ts";
import { type ChannelBotFiles, channelBotFilesFor } from "./channelBotNotes.ts";
import {
  answerForwardIdsFor,
  questionIdFor,
  stopIdsFor,
  turnSteerIdsFor,
  workerLaunchIdsFor,
} from "./channelIds.ts";
import { choosePlacement, type PlacementCandidate } from "./channelPlacement.ts";
import { requesterForDispatch } from "./channelDispatchAuthority.ts";
import { channelNotesRevision, freezeChannelBrief } from "./channelBriefs.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import { channelWorkerRules, workerHeader } from "./channelWorkerBrief.ts";
import { isThreadMissing } from "./channelWorkerObservation.ts";
import { derivePendingBackgroundWork } from "@goat/shared/orchestrationV2PendingBackgroundWork";
import * as SlackChannelSettings from "./SlackChannelSettings.ts";

export class ChannelDispatcher extends Context.Service<
  ChannelDispatcher,
  {
    /** Moves a received task to a worker, or re-runs the launch of a task left dispatching. */
    readonly dispatch: (
      taskId: ChannelTaskId,
      owner: string,
    ) => Effect.Effect<void, ChannelLedger.ChannelLedgerError>;
    /** Sends a recorded answer to the task's worker thread. */
    readonly forward: (
      pending: ChannelLedger.ChannelPendingEvent,
      owner: string,
    ) => Effect.Effect<void, ChannelLedger.ChannelLedgerError>;
  }
>()("goat/channels/ChannelDispatcher") {}

/** What the worker thread is told besides the instruction itself. */
const workerInstruction = (task: ChannelTask, files: ChannelBotFiles) =>
  [
    ...workerHeader(task),
    "Standing notes from the person are in " +
      files.notes +
      "; follow them. Reusable procedures (skills) are in " +
      files.skills +
      "; read the one the instruction names.",
    task.notesChangeRequested === undefined
      ? "Leave the notes file unchanged; this task did not ask to change a note."
      : "The person asked to change or forget a note (" +
        JSON.stringify(task.notesChangeRequested) +
        "). Edit the notes file only to make that change.",
    ...channelWorkerRules("local"),
  ].join("\n");

const MEMORY_CEILING_RANK = { none: 0, read: 1, read_write: 2 } as const;

/** How many pieces of one person's work run at once before more wait in the queue. */
export const WORKERS_PER_REQUESTER = 4;

const sameRequester = (left: ChannelRequester, right: ChannelRequester) =>
  left.ownerId === right.ownerId && left.principalId === right.principalId;

const withoutKey = <V>(map: ReadonlyMap<string, V>, key: string) => {
  const next = new Map(map);
  next.delete(key);
  return next;
};

/** Run states that have ended; anything else may still start or run. */
const ENDED_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
]);

/** How long a stop keeps looking for a worker whose launch was in flight when it was asked. */
const STOP_LAUNCH_GRACE_MS = 120_000;

/**
 * GOAT Bot runs with full access so reading anything never stops on an approval, which makes
 * read-only a promise this text alone keeps. Work that changes things is a coding task.
 */
export const GOAT_BOT_READ_ONLY_RULE =
  "You run with full access and are read-only by instruction: nothing in GOAT stops you, so keep this rule yourself. Read anything that helps: files anywhere on this machine, git history and status, logs, system status, and GOAT's tools. Change nothing yourself: no file edits, no commands that write, install, delete, move, or restart anything, no commits or pushes, and no settings changes in GOAT or anywhere else. Subagents you start keep the same rule. If the request needs a change, say what you found and that it needs a coding task, then report; if it is unclear whether the person wants the change, ask them first.";

/**
 * GOAT Bot hands work to the machines that have room for it; the general placement guidance is in
 * the GOAT orchestration instructions every agent gets.
 */
export const GOAT_BOT_DISPATCH_RULE =
  "When more than one machine is connected, spread work instead of doing it all here: check goat_host_status and the host lists, then start each lane on a machine that has what it needs and room to spare, with delegate_task here or goat_ssh_thread_launch on another machine. Put the read-only rule in every brief you send, never start a Boat cloud machine unless the person asked, rely on GOAT's notifications instead of polling, and say in your answer which machine ran what.";

/**
 * With goatclaw on, GOAT Bot fronts the supervisor (design §8.4): it plans and launches managers,
 * whose profiles carry the authority, and it stays read-only by the rule above.
 */
export const GOAT_BOT_SUPERVISOR_RULE = [
  "goatclaw is on, so you front the goatclaw supervisor. The read-only rule still holds: plan the work and hand every change to a manager.",
  GOATCLAW_SUPERVISOR_DELEGATION,
  GOATCLAW_SUPERVISOR_ASKS,
  "Fold each manager's report into your answer with its exact heads, check totals, and NOT RUN line.",
].join(" ");

/** What a GOAT Bot turn is told besides the person's request. */
const turnInstruction = (task: ChannelTask, files: ChannelBotFiles, supervisor: boolean) =>
  [
    ...workerHeader(task),
    "You are GOAT Bot handling this message yourself. Your summary is your answer to the person: write it in the language of their request, not your default language, short and outcome first.",
    "Look things up directly: read and search files, read GOAT Bot's notes (" +
      files.notes +
      "), use GOAT memory, and use the channel_task_* and goat_thread_* tools to check the work GOAT Bot started and its threads. Hand research, long investigations, or anything that needs several steps to subagents with delegate_task, wait for them, and summarize what they found; do not paste their output.",
    GOAT_BOT_READ_ONLY_RULE,
    GOAT_BOT_DISPATCH_RULE,
    ...(supervisor ? [GOAT_BOT_SUPERVISOR_RULE] : []),
    task.notesChangeRequested === undefined
      ? "Leave the notes file unchanged; this message did not ask to change a note."
      : "The person asked to change or forget a note (" +
        JSON.stringify(task.notesChangeRequested) +
        "). This is the one change you may make yourself: edit the notes file only to make that change.",
    ...channelWorkerRules("local"),
  ].join("\n");

/** The narrower of two memory ceilings. */
const lowerMemoryCeiling = (
  left: MemoryTaskGrantCeiling,
  right: MemoryTaskGrantCeiling,
): MemoryTaskGrantCeiling =>
  MEMORY_CEILING_RANK[left] <= MEMORY_CEILING_RANK[right] ? left : right;

const toLaunchStrategy = (
  strategy: ChannelDispatchTarget["workspaceStrategy"],
): OrchestrationV2ThreadLaunchWorkspaceStrategy =>
  strategy.type === "root"
    ? { type: "root" }
    : { type: "worktree", baseRef: strategy.baseRef ?? "HEAD" };

const make = Effect.gen(function* () {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const usageSources = yield* UsageLimitSources.UsageLimitSources;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const permissions = yield* Profiles.PermissionProfiles;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const remoteWorkers = yield* ChannelRemoteWorkers.ChannelRemoteWorkers;
  const placements = yield* FiberMap.make<string>();
  const placementGate = yield* Semaphore.make(1);
  /** Remote dispatches handed off but not yet claimed, by task, with whose work they are. */
  const remoteReservations = yield* Ref.make<ReadonlyMap<string, ChannelRequester>>(new Map());
  const slackSettings = yield* SlackChannelSettings.SlackChannelSettings;
  const botFiles = channelBotFilesFor(path, (yield* ServerConfig.ServerConfig).stateDir);

  /**
   * The Slack connection's default project and model, for work that came in through it. A
   * settings failure means no defaults; it never picks a different project.
   */
  const originDefaults = (task: ChannelLedger.ChannelStoredTask["task"]) =>
    task.originAddress.kind !== "slack"
      ? Effect.succeed(undefined)
      : slackSettings.defaultTarget(task.originAddress.connectionId).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.catch((error) =>
            Effect.logWarning("Slack default target could not be read", {
              reason: error.reason,
            }).pipe(Effect.as(undefined)),
          ),
        );

  const askRequester = (
    stored: ChannelLedger.ChannelStoredTask,
    text: string,
    owner: string,
    options: {
      readonly clearPendingAnswer?: boolean;
      readonly choices?: ReadonlyArray<string>;
    } = {},
  ) =>
    Effect.gen(function* () {
      const askedAt = DateTime.formatIso(yield* DateTime.now);
      return yield* commitTransition(
        ledger,
        stored,
        {
          type: "task.question.opened",
          payload: {
            question: {
              questionId: questionIdFor(stored.task.taskId, stored.task.version + 1),
              text,
              askedAt,
              ...(options.choices === undefined || options.choices.length < 2
                ? {}
                : { options: options.choices }),
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

  const projectChoices = (yield* makeChannelProjectChoices).question;

  /** Whether this machine has the provider instance and, when it lists models, that model. */
  const modelOffered = (selection: ModelSelection) =>
    Effect.gen(function* () {
      const instance = yield* providers.getInstance(selection.instanceId);
      if (instance === undefined) return false;
      const snapshot = yield* instance.snapshot.getSnapshot;
      return (
        snapshot.models.length === 0 ||
        snapshot.models.some((candidate) => candidate.slug === selection.model)
      );
    });

  /**
   * The configured GOAT Bot model when this machine offers it. Dispatched work falls back to it
   * after the project and server defaults and before the text generation model, so a bot set to
   * a coding model sends its workers there too. A chosen model this machine no longer offers
   * falls back with a warning rather than asking, matching the bot turn itself.
   */
  const goatBotPreferred = Effect.fn("ChannelDispatcher.goatBotPreferred")(function* (
    chosen: ModelSelection | null,
  ) {
    if (chosen === null) return undefined;
    if (yield* modelOffered(chosen)) return chosen;
    yield* Effect.logWarning(
      "GOAT Bot model is not available here; using the text generation model",
      { instanceId: chosen.instanceId, model: chosen.model },
    );
    return undefined;
  });

  /** Channel work already started on this machine, per provider account. */
  const localTasksByInstance = ledger
    .listTasksByStatus(["dispatching", "running", "waiting_input"])
    .pipe(
      Effect.map((stored) => {
        const counts = new Map<string, number>();
        for (const { task } of stored) {
          const target = task.target;
          if (target === undefined || target.remote !== undefined) continue;
          const instanceId = target.modelSelection.instanceId;
          counts.set(instanceId, (counts.get(instanceId) ?? 0) + 1);
        }
        return counts;
      }),
      Effect.orElseSucceed(() => new Map<string, number>()),
    );

  /**
   * The provider account to run a model on here. Another signed-in account of the same provider
   * that offers the model can take the work when it has more quota left or less channel work
   * running; the configured account stays a candidate and wins ties. The reason is for the chip.
   */
  const placeLocally = (selection: ModelSelection, projectId: ProjectId) =>
    Effect.gen(function* () {
      const configured = yield* providers.getInstance(selection.instanceId);
      const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
      const driver =
        configured?.driverKind ?? settings.providerInstances[selection.instanceId]?.driver;
      if (driver === undefined)
        return {
          modelSelection: selection,
          reason: undefined,
          candidates: [] as Array<PlacementCandidate<ModelSelection>>,
        };
      const siblings = (yield* providers.listInstances)
        .toSorted((left, right) => String(left.instanceId).localeCompare(String(right.instanceId)))
        .filter(
          (instance) =>
            instance.instanceId === selection.instanceId ||
            (instance.enabled && instance.driverKind === driver),
        );
      const load = yield* localTasksByInstance;
      const candidates = yield* Effect.forEach(siblings, (instance) =>
        Effect.gen(function* () {
          const raw = yield* instance.snapshot.getSnapshot;
          const snapshot = (yield* usageSources.projectProviders([raw]))[0]!;
          const quotaPool = yield* usageSources.quotaPool;
          const isConfigured = instance.instanceId === selection.instanceId;
          const ready =
            snapshot.enabled &&
            snapshot.installed &&
            (snapshot.status === "ready" || snapshot.status === "warning") &&
            snapshot.auth.status !== "unauthenticated" &&
            (snapshot.availability ?? "available") === "available";
          const offers =
            snapshot.models.length === 0 ||
            snapshot.models.some((candidate) => candidate.slug === selection.model);
          if (
            !(ready && offers) ||
            !resolveProjectProviderInstanceEnabled(settings, projectId, instance.instanceId)
          )
            return [];
          const windows = snapshot.usageLimits?.windows ?? [];
          const candidate: PlacementCandidate<ModelSelection> = {
            value: isConfigured ? selection : { ...selection, instanceId: instance.instanceId },
            host: null,
            providerLabel:
              instance.displayName ?? snapshot.displayName ?? String(instance.instanceId),
            preferred: isConfigured,
            windows: windows.length === 0 ? null : windows,
            checkedAt: snapshot.usageLimits?.checkedAt,
            activeTasks: load.get(instance.instanceId) ?? 0,
            model: selection.model,
            quotaPool:
              quotaPool?.producer.homeId === snapshot.usageLimits?.quotaPool?.homeId
                ? quotaPool?.providers.find(
                    (item) => item.provider === snapshot.usageLimits?.quotaPool?.provider,
                  )
                : undefined,
          };
          return [candidate];
        }),
      );
      const pool = candidates.flat();
      const placed = choosePlacement(pool, DateTime.toEpochMillis(yield* DateTime.now));
      return {
        modelSelection: placed?.chosen.value ?? selection,
        reason: placed?.reason,
        candidates: pool,
      };
    });

  /**
   * The memory a task's worker may use: what the requester was granted, the same rule MCP and
   * scheduled launches use. A Slack requester is judged by the identity link as it stands now,
   * so a link narrowed or removed since the message arrived counts. A task that already chose a
   * target never gets more than that target recorded, so choosing again cannot widen it.
   */
  const requesterMemoryCeiling = (task: ChannelTask) =>
    Effect.gen(function* () {
      const recorded = task.target === undefined ? undefined : task.target.memoryGrantCeiling;
      const cap = (ceiling: MemoryTaskGrantCeiling): MemoryTaskGrantCeiling =>
        task.target === undefined ? ceiling : lowerMemoryCeiling(ceiling, recorded ?? "none");
      let scopes = task.requester.grantedScopes;
      if (task.originAddress.kind === "slack" || task.originAddress.kind === "imessage") {
        const actor = task.requester.externalActorId;
        if (actor === undefined) return "none" satisfies MemoryTaskGrantCeiling;
        const linked = yield* ledger.findIdentity({
          connectionId: task.originAddress.connectionId,
          externalActorId: actor,
        });
        if (linked === undefined) return "none" satisfies MemoryTaskGrantCeiling;
        scopes = scopes.filter((scope) => linked.grantedScopes.includes(scope));
      }
      // A read-only destination still narrows this when the thread starts.
      return cap(captureMemoryGrantCeiling(scopes, false));
    });

  /** The launch settings for a task, or the question to ask when they cannot be chosen. */
  const resolveTarget = (stored: ChannelLedger.ChannelStoredTask, allowRemote = false) =>
    Effect.gen(function* () {
      const task = stored.task;
      const bot = yield* ledger.getBot(stored.ownerId);
      const shells = yield* projects.listShells().pipe(Effect.orElseSucceed(() => []));
      if (task.kind === "turn") return yield* turnTarget(task, bot?.bot.projectId, shells);
      const real = shells.filter((shell) => shell.id !== bot?.bot.projectId);
      const allowed = real.length > 0 ? real : shells;
      const hostWorkspace = shells.some((shell) => shell.id === bot?.bot.projectId);
      const defaults = yield* originDefaults(task);
      // A project named with the work wins over the channel's default project.
      const projectId = task.projectId ?? defaults?.projectId;
      // Named work may also go to the bot's own workspace, for work about the machine itself.
      let chosen = shells.find((shell) => shell.id === projectId);
      if (projectId !== undefined && chosen === undefined) {
        const choices = yield* projectChoices(allowed, hostWorkspace);
        return {
          ...choices,
          text: "I can't start work in that project. " + choices.text,
        };
      }
      if (chosen === undefined && allowed.length === 1) chosen = allowed[0];
      if (chosen === undefined) {
        if (allowed.length === 0) {
          return {
            type: "question" as const,
            text: "There is no project to work in yet. Add one in GOAT, then answer with its name.",
          };
        }
        return yield* projectChoices(allowed, hostWorkspace);
      }
      const all = yield* serverSettings.getSettings.pipe(Effect.orDie);
      const settings = resolveProjectSettings(all, chosen.id).settings;
      const projectModel =
        chosen.defaultModelSelection ??
        settings.defaultModelSelection ??
        (yield* goatBotPreferred(all.goatBotModelSelection)) ??
        settings.textGenerationModelSelection;
      // The Slack connection's model applies only where it is offered. Slack settings have no
      // control to change it, so an unavailable one falls back to the project's model with a
      // warning instead of asking a question the requester cannot act on.
      const preferred =
        defaults?.modelSelection === undefined
          ? undefined
          : (yield* modelOffered(defaults.modelSelection))
            ? defaults.modelSelection
            : undefined;
      if (defaults?.modelSelection !== undefined && preferred === undefined) {
        yield* Effect.logWarning("Slack default model is not available here; using the project's", {
          instanceId: defaults.modelSelection.instanceId,
          model: defaults.modelSelection.model,
        });
      }
      const modelSelection = preferred ?? projectModel;
      const isGit = yield* fileSystem
        .exists(path.join(chosen.workspaceRoot, ".git"))
        .pipe(Effect.orElseSucceed(() => false));
      const memoryGrantCeiling = yield* requesterMemoryCeiling(task);
      const placed = yield* placeLocally(modelSelection, chosen.id);
      if (!allowRemote && placed.candidates.length === 0)
        return {
          type: "question" as const,
          text: "No ready account offers the requested model. Check the project’s provider settings.",
        };
      const target: ChannelDispatchTarget = {
        environmentId: yield* environment.getEnvironmentId,
        projectId: chosen.id,
        modelSelection: placed.modelSelection,
        runtimeMode: lowerRuntimeMode(
          task.requester.runtimeModeCeiling,
          settings.defaultRuntimeMode,
        ),
        interactionMode: "default",
        // Each task in a repository gets its own worktree so two tasks never share a checkout.
        workspaceStrategy: isGit ? { type: "worktree", baseRef: "HEAD" } : { type: "root" },
        ...(placed.reason === undefined ? {} : { placementReason: placed.reason }),
        ...(memoryGrantCeiling === "none" ? {} : { memoryGrantCeiling }),
      };
      return { type: "target" as const, target, requestedSelection: modelSelection };
    });

  /**
   * A GOAT Bot turn runs in the bot's own workspace on this machine, on GOAT Bot's model: the
   * one chosen in settings, else the new-thread default, else the text generation model. A
   * chosen model this machine no longer offers falls back with a warning rather than asking,
   * because the person asked a question, not for a model. It runs with full access, capped only
   * by what the requester may do, so a person linked below full access never gets more through
   * the bot than the prompt's read-only promise.
   */
  const turnTarget = (
    task: ChannelTask,
    botProjectId: string | undefined,
    shells: ReadonlyArray<{ readonly id: ProjectId }>,
  ) =>
    Effect.gen(function* () {
      const home = shells.find((shell) => shell.id === botProjectId);
      if (home === undefined) {
        return {
          type: "question" as const,
          text: "I can't find my own workspace on this machine. Open GOAT Bot in GOAT once, then ask again.",
        };
      }
      const all = yield* serverSettings.getSettings.pipe(Effect.orDie);
      // The environment's settings, not the bot workspace's: the settings page shows and saves
      // the bot's model from the same resolution, so what it says is what runs.
      const fallback = resolveGoatBotModelSelection({ ...all, goatBotModelSelection: null });
      const chosen = all.goatBotModelSelection;
      const preferred = chosen !== null && (yield* modelOffered(chosen)) ? chosen : undefined;
      if (chosen !== null && preferred === undefined) {
        yield* Effect.logWarning("GOAT Bot model is not available here; using the default", {
          instanceId: chosen.instanceId,
          model: chosen.model,
        });
      }
      const memoryGrantCeiling = yield* requesterMemoryCeiling(task);
      const target: ChannelDispatchTarget = {
        environmentId: yield* environment.getEnvironmentId,
        projectId: home.id,
        modelSelection: preferred ?? fallback,
        runtimeMode: task.requester.runtimeModeCeiling,
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        ...(memoryGrantCeiling === "none" ? {} : { memoryGrantCeiling }),
      };
      return { type: "target" as const, target };
    });

  const launch = (initial: ChannelLedger.ChannelStoredTask, owner: string) =>
    Effect.gen(function* () {
      if (initial.task.target === undefined) return;
      if (
        (yield* requesterForDispatch(initial.task).pipe(
          Effect.provideService(ChannelLedger.ChannelLedger, ledger),
        )) === undefined
      ) {
        yield* commitTransition(
          ledger,
          initial,
          {
            type: "task.failed",
            payload: {
              generation: initial.task.generation,
              reason: "permission_changed",
              summary: "The requester’s permission to start this work changed.",
            },
          },
          { owner, narrate: true },
        );
        return;
      }
      const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
      const supervisor = initial.task.kind === "turn" && settings.goatclaw.enabled;
      // The project's standing instructions go in front, as goat_thread_launch puts them, so a
      // channel worker follows the rules every thread in that project follows.
      const standing = resolveProjectSettings(settings, initial.task.target.projectId).settings
        .standingInstructions;
      const { stored, brief } = yield* freezeChannelBrief(
        ledger,
        initial,
        owner,
        prependStandingInstructions(
          standing,
          initial.task.kind === "turn"
            ? turnInstruction(initial.task, botFiles, supervisor)
            : workerInstruction(initial.task, botFiles),
        ).text,
        {
          notesPath: botFiles.notes,
          notesRevision:
            initial.task.briefVersion === undefined
              ? yield* channelNotesRevision(botFiles.notes).pipe(
                  Effect.provideService(FileSystem.FileSystem, fileSystem),
                )
              : null,
          skillsPath: botFiles.skills,
        },
      );
      const task = stored.task;
      const target = task.target!;
      const currentRequester = yield* requesterForDispatch(task).pipe(
        Effect.provideService(ChannelLedger.ChannelLedger, ledger),
      );
      if (currentRequester === undefined) {
        return yield* commitTransition(
          ledger,
          stored,
          {
            type: "task.failed",
            payload: {
              generation: task.generation,
              reason: "permission_changed",
              summary: "The requester’s permission to start this work changed.",
            },
          },
          { owner, narrate: true },
        ).pipe(Effect.asVoid);
      }
      const ids = workerLaunchIdsFor(task.taskId, task.generation);
      // Only a requester at full access may act through the supervisor's owner profile; anyone
      // linked lower keeps the default profile, so the bot never gives them more than they hold.
      if (supervisor && currentRequester.runtimeModeCeiling === "full-access")
        yield* permissions
          .bind(
            ids.threadId,
            goatclawRoleTemplate("supervisor").profileId,
            `channel:${task.requester.ownerId}`,
          )
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("GOAT Bot turn keeps the default profile", { cause: error }),
            ),
          );
      const launched = yield* launches
        .launch({
          commandId: ids.commandId,
          threadId: ids.threadId,
          projectId: ProjectId.make(target.projectId),
          title: task.title,
          generateTitle: false,
          modelSelection: target.modelSelection,
          runtimeMode: target.runtimeMode,
          interactionMode: target.interactionMode,
          workspaceStrategy: toLaunchStrategy(target.workspaceStrategy),
          initialMessage: {
            messageId: ids.messageId,
            text: brief.deliveredText,
            attachments: [],
            ...(target.memoryGrantCeiling === undefined
              ? {}
              : { memoryGrantCeiling: target.memoryGrantCeiling }),
          },
          createdBy: "system",
          creationSource: "server",
        })
        .pipe(Effect.result);
      if (launched._tag === "Failure") {
        yield* Effect.logWarning("channel worker launch failed", {
          taskId: task.taskId,
          cause: launched.failure,
        });
        yield* commitTransition(
          ledger,
          stored,
          {
            type: "task.failed",
            payload: {
              generation: task.generation,
              reason: "launch_failed",
              summary: "The coding thread could not start.",
            },
          },
          { owner, narrate: true },
        );
        return;
      }
      const run = launched.success.projection.runs.find(
        (candidate) => candidate.userMessageId === ids.messageId,
      );
      yield* commitTransition(
        ledger,
        stored,
        {
          type: "task.worker.bound",
          payload: {
            worker: {
              environmentId: target.environmentId,
              threadId: launched.success.threadId,
              ...(run === undefined ? {} : { runId: run.id }),
              generation: task.generation,
            },
          },
        },
        { owner },
      );
    });

  /**
   * What a task on another machine falls back to from this one: the named project's model and
   * runtime mode, and its title and repository key to find the same project there.
   */
  const remoteHints = (stored: ChannelLedger.ChannelStoredTask) =>
    Effect.gen(function* () {
      const task = stored.task;
      const defaults = yield* originDefaults(task);
      const shells = yield* projects.listShells().pipe(Effect.orElseSucceed(() => []));
      // The project named with the work, else the Slack connection's default, finds its
      // counterpart on the other machine.
      const named = shells.find((shell) => shell.id === (task.projectId ?? defaults?.projectId));
      // A default project that is gone must not let the other machine's only project stand in
      // for it: the remote side asks until the requester names one.
      const defaultProjectGone =
        task.projectId === undefined && defaults?.projectId !== undefined && named === undefined;
      const identities = yield* Effect.serviceOption(
        RepositoryIdentityResolver.RepositoryIdentityResolver,
      );
      const identity =
        named === undefined || identities._tag === "None"
          ? null
          : yield* identities.value.resolve(named.workspaceRoot);
      const all = yield* serverSettings.getSettings.pipe(Effect.orDie);
      const settings = resolveProjectSettings(all, named?.id ?? null).settings;
      const bot = yield* ledger.getBot(stored.ownerId);
      return {
        ...(defaultProjectGone ? { requireNamedProject: true } : {}),
        memoryGrantCeiling: yield* requesterMemoryCeiling(task),
        localProjects: shells
          .filter((shell) => shell.id !== bot?.bot.projectId)
          .map((shell) => ({ id: shell.id, title: shell.title })),
        modelSelection:
          named?.defaultModelSelection ??
          settings.defaultModelSelection ??
          all.goatBotModelSelection ??
          settings.textGenerationModelSelection,
        runtimeMode: lowerRuntimeMode(
          task.requester.runtimeModeCeiling,
          settings.defaultRuntimeMode,
        ),
        ...(defaults?.modelSelection === undefined
          ? {}
          : { preferredModelSelection: defaults.modelSelection }),
        ...(named === undefined ? {} : { title: named.title }),
        ...(identity === null ? {} : { canonicalKey: identity.canonicalKey }),
      };
    });

  const autoPlace = Effect.fn("ChannelDispatcher.autoPlace")(function* (
    initial: ChannelLedger.ChannelStoredTask,
    owner: string,
  ) {
    const requester = yield* requesterForDispatch(initial.task).pipe(
      Effect.provideService(ChannelLedger.ChannelLedger, ledger),
    );
    if (requester === undefined) return;
    const stored = initial;
    const resolved = yield* resolveTarget({ ...stored, task: { ...stored.task, requester } }, true);
    if (resolved.type === "question")
      return yield* askRequester(
        stored,
        resolved.text,
        owner,
        "choices" in resolved ? { choices: resolved.choices } : {},
      );
    if (!("requestedSelection" in resolved)) return;
    const shells = yield* projects.listShells();
    const project = shells.find((shell) => shell.id === resolved.target.projectId);
    const identities = yield* Effect.serviceOption(
      RepositoryIdentityResolver.RepositoryIdentityResolver,
    );
    const identity =
      project === undefined || Option.isNone(identities)
        ? null
        : yield* identities.value.resolve(project.workspaceRoot);
    const provider = yield* providers.getInstance(resolved.requestedSelection.instanceId);
    const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
    const driver =
      provider?.driverKind ??
      settings.providerInstances[resolved.requestedSelection.instanceId]?.driver;
    const candidates =
      identity === null || driver === undefined
        ? []
        : yield* remoteWorkers.placementCandidates(
            stored,
            { ...resolved.target, modelSelection: resolved.requestedSelection },
            identity.canonicalKey,
            driver,
            owner,
          );
    const claimed = yield* Effect.gen(function* () {
      const current = yield* ledger.getTask(stored.task.taskId);
      if (
        current === undefined ||
        current.task.status !== "received" ||
        current.task.generation !== stored.task.generation ||
        current.task.version !== stored.task.version
      )
        return;
      const who = yield* requesterForDispatch(current.task).pipe(
        Effect.provideService(ChannelLedger.ChannelLedger, ledger),
      );
      if (who === undefined) {
        yield* commitTransition(
          ledger,
          current,
          {
            type: "task.failed",
            payload: {
              generation: current.task.generation,
              reason: "permission_changed",
              summary: "The requester’s permission to start this work changed.",
            },
          },
          { owner, narrate: true },
        );
        return;
      }
      const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
      const local = yield* placeLocally(resolved.requestedSelection, resolved.target.projectId);
      const pool = [
        ...local.candidates.map((candidate): PlacementCandidate<ChannelDispatchTarget> => ({
          ...candidate,
          value: { ...resolved.target, modelSelection: candidate.value },
        })),
        ...(settings.channelAutoPlacement ? candidates : []),
      ];
      const busy = yield* ledger.listTasksByStatus(["dispatching", "running", "waiting_input"]);
      if (
        (yield* ledger.countBusyTasks({ ownerId: who.ownerId, principalId: who.principalId })) >=
        WORKERS_PER_REQUESTER
      )
        return;
      const placed = choosePlacement(
        pool.map((candidate) => ({
          ...candidate,
          activeTasks: busy.filter(
            ({ task }) =>
              task.kind !== "turn" &&
              (task.status !== "waiting_input" || task.worker !== undefined) &&
              task.target !== undefined &&
              (task.target.remote?.host ?? null) === candidate.host,
          ).length,
        })),
        DateTime.toEpochMillis(yield* DateTime.now),
      );
      if (placed === undefined)
        return yield* askRequester(
          current,
          "No ready account on an eligible machine offers the requested model.",
          owner,
        ).pipe(Effect.as(undefined));
      const memory = yield* requesterMemoryCeiling({ ...current.task, requester: who });
      const target: ChannelDispatchTarget = {
        ...placed.chosen.value,
        ...(placed.chosen.value.remote?.automatic === undefined
          ? {}
          : {
              remote: {
                ...placed.chosen.value.remote,
                automatic: {
                  ...placed.chosen.value.remote.automatic,
                  runtimeModeCeiling: who.runtimeModeCeiling,
                },
              },
            }),
        runtimeMode: lowerRuntimeMode(placed.chosen.value.runtimeMode, who.runtimeModeCeiling),
        memoryGrantCeiling: memory,
        placementReason:
          (placed.reason ?? "This machine · usage not reported") +
          (settings.channelAutoPlacement && candidates.length === 0
            ? " · no verified remote candidate for this repository"
            : ""),
      };
      // An auto probe uses the same authority as its launch; a narrowed grant invalidates it.
      if (
        target.remote !== undefined &&
        (who.runtimeModeCeiling !== requester.runtimeModeCeiling ||
          memory !== (resolved.target.memoryGrantCeiling ?? "none"))
      )
        return;
      return yield* commitTransition(
        ledger,
        current,
        {
          type: "task.dispatch.claimed",
          payload: {
            generation: current.task.generation,
            target,
            leaseExpiresAt: DateTime.formatIso(yield* DateTime.now),
          },
        },
        { owner, narrate: true },
      );
    }).pipe(placementGate.withPermit);
    if (claimed === undefined) return;
    if (claimed.target?.remote !== undefined)
      return yield* remoteWorkers.launch(claimed.taskId, owner);
    const current = yield* ledger.getTask(claimed.taskId);
    if (current !== undefined) yield* launch(current, owner);
  });

  const dispatch: ChannelDispatcher["Service"]["dispatch"] = (taskId, owner) =>
    Effect.gen(function* () {
      const stored = yield* ledger.getTask(taskId);
      if (stored === undefined) return;
      let dispatchRequester = stored.task.requester;
      if (stored.task.status === "received") {
        const requester = yield* requesterForDispatch(stored.task).pipe(
          Effect.provideService(ChannelLedger.ChannelLedger, ledger),
        );
        if (requester === undefined) {
          yield* commitTransition(
            ledger,
            stored,
            {
              type: "task.failed",
              payload: {
                generation: stored.task.generation,
                reason: "permission_changed",
                summary: "The requester’s permission to start this work changed.",
              },
            },
            { owner, narrate: true },
          );
          return;
        }
        dispatchRequester = requester;
      }
      // A generation that may already run on another machine never starts anywhere else.
      if (stored.task.status === "received" || stored.task.status === "dispatching") {
        const elsewhere = yield* remoteWorkers.attemptedElsewhere(stored);
        if (elsewhere !== undefined) {
          yield* commitTransition(
            ledger,
            stored,
            {
              type: "task.failed",
              payload: {
                generation: stored.task.generation,
                reason: "launch_uncertain",
                summary: ChannelRemoteWorkers.REMOTE_COPY.launchUncertain(elsewhere),
              },
            },
            { owner, narrate: true },
          );
          return;
        }
      }
      if (stored.task.status === "dispatching") {
        if (stored.task.target?.remote !== undefined) {
          return yield* remoteWorkers.launch(taskId, owner);
        }
        return yield* launch(stored, owner);
      }
      if (stored.task.status !== "received") return;
      // At most this many pieces of a person's work hold a worker at once; the rest wait as
      // received and the runtime, going oldest first, dispatches them as earlier work ends. A
      // remote dispatch claims the task only after it resolves the machine, so the ones handed
      // off but not yet claimed count too.
      const requester = stored.task.requester;
      let inFlight = 0;
      for (const [reservedId, who] of yield* Ref.get(remoteReservations)) {
        if (reservedId === taskId || !sameRequester(who, requester)) continue;
        const current = yield* ledger.getTask(reservedId as ChannelTaskId);
        if (current?.task.status === "received") inFlight += 1;
        else yield* Ref.update(remoteReservations, (map) => withoutKey(map, reservedId));
      }
      const busy =
        (yield* ledger.countBusyTasks({
          ownerId: requester.ownerId,
          principalId: requester.principalId,
        })) + inFlight;
      if (busy >= WORKERS_PER_REQUESTER) return;
      if (
        stored.task.kind !== "turn" &&
        stored.task.host === undefined &&
        (yield* serverSettings.getSettings.pipe(Effect.orDie)).channelAutoPlacement
      ) {
        yield* Ref.update(remoteReservations, (map) => new Map(map).set(taskId, requester));
        yield* FiberMap.run(
          placements,
          taskId,
          autoPlace(stored, owner).pipe(
            Effect.catchCause(() =>
              Effect.logWarning("channel automatic placement failed", { taskId }),
            ),
            Effect.ensuring(Ref.update(remoteReservations, (map) => withoutKey(map, taskId))),
          ),
          { onlyIfMissing: true },
        );
        return;
      }
      if (stored.task.host !== undefined) {
        yield* Ref.update(remoteReservations, (map) => new Map(map).set(taskId, requester));
        return yield* remoteWorkers.dispatch(
          taskId,
          owner,
          yield* remoteHints({ ...stored, task: { ...stored.task, requester: dispatchRequester } }),
        );
      }
      const resolved = yield* resolveTarget({
        ...stored,
        task: { ...stored.task, requester: dispatchRequester },
      });
      if (resolved.type === "question") {
        return yield* askRequester(
          stored,
          resolved.text,
          owner,
          "choices" in resolved ? { choices: resolved.choices } : {},
        );
      }
      const claimedAt = DateTime.formatIso(yield* DateTime.now);
      const claimed = yield* commitTransition(
        ledger,
        stored,
        {
          type: "task.dispatch.claimed",
          payload: {
            generation: stored.task.generation,
            target: resolved.target,
            leaseExpiresAt: claimedAt,
          },
        },
        { owner, narrate: resolved.target.placementReason !== undefined },
      );
      if (claimed === undefined) return;
      const reread = yield* ledger.getTask(taskId);
      if (reread !== undefined) yield* launch(reread, owner);
    });

  /**
   * Sends a recorded follow-up to its task's worker: into the running run when it can take
   * steering, else as the thread's next run. The ids come from the input, so a resend after a
   * restart lands on the same message. The task then binds to the run that took it and the
   * completion fence set with the follow-up is lifted in the same write, so the task settles on
   * that run and never on the one before it.
   */
  const forwardFollowUp = (
    pending: ChannelLedger.ChannelPendingEvent,
    event: Extract<ChannelLedger.ChannelPendingEvent["event"], { type: "task.followup.received" }>,
    owner: string,
  ) =>
    Effect.gen(function* () {
      const stored = yield* ledger.getTask(event.taskId);
      const worker = stored?.task.worker;
      const target = stored?.task.target;
      // Work that was stopped, finished, or restarted as a new generation never gets an old
      // follow-up: sending it would start a run nothing reports on.
      if (
        stored === undefined ||
        worker === undefined ||
        target === undefined ||
        (stored.task.status !== "running" && stored.task.status !== "waiting_input") ||
        stored.task.generation !== event.payload.generation
      ) {
        yield* ledger.completeForward({ owner, sequence: pending.sequence });
        return;
      }
      // In order per task: a later follow-up never overtakes an earlier one still waiting.
      if (
        yield* ledger.hasEarlierPendingForward({ taskId: event.taskId, sequence: pending.sequence })
      ) {
        return;
      }
      // A person stopped the worker's run in GOAT after this follow-up was recorded. Sending it
      // would start the worker again; instead the follow-up is dropped and the fence lifted, so
      // reconciliation records the stop as it does for any stopped run.
      const records = yield* threads
        .getThreadRecords(worker.threadId, ["runs"])
        .pipe(Effect.option);
      const newest = Option.match(records, {
        onNone: () => undefined,
        onSome: (value) =>
          value.runs.toSorted((left, right) => left.ordinal - right.ordinal).at(-1),
      });
      if (newest?.status === "cancelled") {
        const latest = (yield* ledger.getTask(event.taskId)) ?? stored;
        if (latest.pendingAnswerMessageId !== undefined) {
          const lifted = yield* commitTransition(
            ledger,
            latest,
            { type: "task.worker.bound", payload: { worker: { ...worker, runId: newest.id } } },
            { owner, pendingAnswerMessageId: null },
          );
          if (lifted === undefined) return;
        }
        yield* ledger.completeForward({ owner, sequence: pending.sequence });
        return;
      }
      const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
      const send = (attempt: "first" | "queued") => {
        const ids = turnSteerIdsFor(event.payload.inputId, attempt);
        return threads
          .sendToThread({
            projectId: ProjectId.make(target.projectId),
            commandId: ids.commandId,
            threadId: worker.threadId,
            messageId: ids.messageId,
            text: "Follow-up from " + event.payload.from + ": " + event.payload.text,
            attachments: [],
            // First into the running run when it can take steering; the second attempt only
            // queues, which the thread accepts whatever its run is doing.
            mode: attempt === "first" ? "auto" : "queue",
            createdBy: "user",
            creationSource: "server",
          })
          .pipe(
            Effect.provideService(DispatchModeLimit, {
              runtimeMode: stored.task.requester.runtimeModeCeiling,
              interactionMode: "default",
              refused,
            }),
            Effect.result,
          );
      };
      const rejected = (failure: { readonly _tag: string }) =>
        failure._tag === "OrchestratorCommandRejectedError" ||
        failure._tag === "OrchestratorCommandPreviouslyRejectedError";
      let sent = yield* send("first");
      // A rejected command id is refused for good, so a definite rejection gets one more attempt
      // under its own ids rather than retrying the same ones forever.
      if (
        sent._tag === "Failure" &&
        rejected(sent.failure) &&
        (yield* Ref.get(refused)) === undefined
      ) {
        sent = yield* send("queued");
      }
      if (sent._tag === "Failure") {
        const refusal = yield* Ref.get(refused);
        if (refusal !== undefined || rejected(sent.failure)) {
          // Read again: an earlier follow-up's question may have moved the task since.
          const asked = yield* askRequester(
            (yield* ledger.getTask(event.taskId)) ?? stored,
            refusal !== undefined
              ? "The thread doing this now runs in " +
                  refusal.runtimeMode +
                  " mode, above what this work may use, so I didn't pass on your follow-up (\"" +
                  event.payload.text +
                  "\"). Lower the thread's mode in GOAT, or say it again there."
              : "The thread doing this didn't take your follow-up (\"" +
                  event.payload.text +
                  '"). Say it again, or open the thread in GOAT.',
            owner,
            { clearPendingAnswer: true },
          );
          // Done only once the person has been told; otherwise the next pass tells them.
          if (asked === undefined) return;
          yield* ledger.completeForward({ owner, sequence: pending.sequence });
          return;
        }
        // Not known to be refused; the next pass sends it again under the same ids.
        yield* Effect.logWarning("channel follow-up forward failed", {
          taskId: stored.task.taskId,
          cause: sent.failure,
        });
        return;
      }
      const latest = yield* ledger.getTask(event.taskId);
      if (
        latest === undefined ||
        latest.task.worker === undefined ||
        (latest.task.status !== "running" && latest.task.status !== "waiting_input")
      ) {
        // Settling waits for pending forwards, so this means the task was stopped meanwhile.
        yield* ledger.completeForward({ owner, sequence: pending.sequence });
        return;
      }
      // Bind the task to the run that took the follow-up. Only the follow-up that set the fence
      // lifts it; an earlier one leaves a later one's fence in place.
      const own = [
        turnSteerIdsFor(event.payload.inputId, "first").messageId,
        turnSteerIdsFor(event.payload.inputId, "queued").messageId,
      ] as ReadonlyArray<string>;
      const ownsFence =
        latest.pendingAnswerMessageId !== undefined && own.includes(latest.pendingAnswerMessageId);
      if (ownsFence || latest.task.worker.runId !== sent.success.run.id) {
        const bound = yield* commitTransition(
          ledger,
          latest,
          {
            type: "task.worker.bound",
            payload: { worker: { ...latest.task.worker, runId: sent.success.run.id } },
          },
          { owner, ...(ownsFence ? { pendingAnswerMessageId: null } : {}) },
        );
        // A concurrent write moved the task; the next pass sends again under the same ids,
        // which lands on the same run, and binds then.
        if (bound === undefined) return;
      }
      yield* ledger.completeForward({ owner, sequence: pending.sequence });
    });

  /**
   * Stops the worker of a task a person stopped from chat: a full thread stop, which also holds
   * anything queued behind the run, then every subagent the worker started. The ids come from the
   * stop event, so replaying the forward after a crash stops once. A worker on another machine is
   * stopped there. A launch that was in flight when the stop was asked lands on the thread id the
   * task's generation derives, so that thread is stopped too once it exists. Each step that fails
   * stays pending and is retried.
   */
  const stopWorker = (pending: ChannelLedger.ChannelPendingEvent, owner: string) =>
    Effect.gen(function* () {
      const stored = yield* ledger.getTask(pending.event.taskId);
      const done = ledger.completeForward({ owner, sequence: pending.sequence });
      if (stored === undefined) return yield* done;
      const task = stored.task;
      if (task.worker?.host !== undefined || task.target?.remote !== undefined) {
        return yield* remoteWorkers.stop(pending, owner);
      }
      // Never claimed for a launch: the ledger write was the whole stop.
      if (task.target === undefined) return yield* done;
      const threadId =
        task.worker?.threadId ?? workerLaunchIdsFor(task.taskId, task.generation).threadId;
      const ids = stopIdsFor(pending.event.eventId);
      const read = yield* threads
        .getThreadRecords(threadId, ["runs", "providerThreads", "turnItems"], {
          turnItemStatuses: ["pending", "running", "waiting"],
        })
        .pipe(Effect.result);
      if (read._tag === "Failure") {
        // A read that failed says nothing; only a thread that does not exist may be a launch
        // that never landed, and only once the grace for one in flight has passed.
        if (!isThreadMissing(read.failure)) return;
        const age =
          DateTime.toEpochMillis(yield* DateTime.now) - Date.parse(pending.event.occurredAt);
        if (age > STOP_LAUNCH_GRACE_MS) yield* done;
        return;
      }
      const records = { value: read.success };
      // Anything not yet ended is alive: queued, preparing, starting, running, waiting, or a
      // finished run whose provider still works in the background or in the cloud.
      const runs = records.value.runs;
      const latestRun = runs.findLast((run) => run.status !== "queued");
      const background =
        latestRun !== undefined &&
        derivePendingBackgroundWork({
          latestRun,
          providerThreads: records.value.providerThreads,
          turnItems: records.value.turnItems,
          activeProviderThreadId: records.value.thread.activeProviderThreadId,
          runs,
        }).length > 0;
      // A cloud task still running or being submitted keeps working whatever the runs say, as
      // the orchestrator's own stop treats it.
      const cloud = records.value.providerThreads.some(
        (thread) =>
          thread.cloudTask?.status === "running" || thread.cloudTask?.status === "submitting",
      );
      const live =
        runs.findLast((run) => !ENDED_RUN_STATUSES.has(run.status)) ??
        (background || cloud ? latestRun : undefined);
      const stopThread = (commandId: CommandId) =>
        threads
          .dispatch({ type: "thread.stop", commandId, threadId, reason: "Stopped from GOAT Bot." })
          .pipe(Effect.result);
      const refusedFor = (failure: unknown) => {
        const tag = (failure as { readonly _tag?: string })._tag;
        return (
          tag === "OrchestratorCommandRejectedError" ||
          tag === "OrchestratorCommandPreviouslyRejectedError"
        );
      };
      // A refused command id is refused for good, so each refusal while something still runs
      // moves the stop to a new attempt id; the next pass tries that one.
      const attempt = yield* ledger.stopAttempt(pending.event.eventId);
      const stopped = yield* stopThread(
        attempt === 0
          ? ids.interrupt
          : stopIdsFor(pending.event.eventId, "attempt-" + attempt).interrupt,
      );
      if (stopped._tag === "Failure" && refusedFor(stopped.failure) && live !== undefined) {
        yield* ledger.advanceStopAttempt({
          eventId: pending.event.eventId,
          from: attempt,
          now: DateTime.formatIso(yield* DateTime.now),
        });
      }
      if (stopped._tag === "Failure") {
        // A refused stop is done only if nothing is left running there.
        if (!refusedFor(stopped.failure) || live !== undefined) {
          yield* Effect.logWarning("channel worker stop failed; retrying", {
            taskId: task.taskId,
            cause: stopped.failure,
          });
          return;
        }
      }
      const subagents = yield* threads
        .stopDelegatedTasks({
          threadId,
          commandId: ids.subagents,
          reason: "Stopped from GOAT Bot.",
        })
        .pipe(Effect.result);
      if (subagents._tag === "Failure") {
        yield* Effect.logWarning("channel subagent stop failed; retrying", {
          taskId: task.taskId,
          cause: subagents.failure,
        });
        return;
      }
      yield* done;
    });

  const forward: ChannelDispatcher["Service"]["forward"] = (pending, owner) =>
    Effect.gen(function* () {
      const event = pending.event;
      if (event.type === "task.followup.received") {
        return yield* forwardFollowUp(pending, event, owner);
      }
      if (event.type === "task.cancelled") return yield* stopWorker(pending, owner);
      const stored = yield* ledger.getTask(event.taskId);
      const worker = stored?.task.worker;
      if (worker?.host !== undefined) return yield* remoteWorkers.forward(pending, owner);
      const projectId = stored?.task.target?.projectId;
      if (
        event.type !== "task.question.answered" ||
        stored === undefined ||
        worker === undefined ||
        projectId === undefined
      ) {
        yield* ledger.completeForward({ owner, sequence: pending.sequence });
        return;
      }
      const ids = answerForwardIdsFor(event.eventId);
      // The worker's modes may have been raised since the task started. The orchestrator re-checks
      // them against the requester's ceiling inside the thread's command lock.
      const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
      const sent = yield* threads
        .sendToThread({
          projectId: ProjectId.make(projectId),
          commandId: ids.commandId,
          threadId: worker.threadId,
          messageId: ids.messageId,
          text: "Answer from " + stored.task.requester.displayName + ": " + event.payload.answer,
          attachments: [],
          mode: "queue",
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(
          Effect.provideService(DispatchModeLimit, {
            runtimeMode: stored.task.requester.runtimeModeCeiling,
            interactionMode: "default",
            refused,
          }),
          Effect.result,
        );
      if (sent._tag === "Failure") {
        const refusal = yield* Ref.get(refused);
        if (refusal !== undefined) {
          // Keep the answer's intent: ask again, so the requester can lower the thread or answer there.
          yield* askRequester(
            stored,
            "The coding thread now runs in " +
              refusal.runtimeMode +
              " mode, above what this task may use, so I didn't pass on your answer (\"" +
              event.payload.answer +
              "\"). Lower the thread's mode in GOAT and answer again, or answer in the thread.",
            owner,
            { clearPendingAnswer: true },
          );
          yield* ledger.completeForward({ owner, sequence: pending.sequence });
          return;
        }
        // Left pending; the next scan sends it again under the same command id.
        yield* Effect.logWarning("channel answer forward failed", {
          taskId: stored.task.taskId,
          cause: sent.failure,
        });
        return;
      }
      yield* ledger.completeForward({ owner, sequence: pending.sequence });
    });

  return ChannelDispatcher.of({ dispatch, forward });
});

export const layer = Layer.effect(ChannelDispatcher, make).pipe(Layer.provide(Profiles.layer));
