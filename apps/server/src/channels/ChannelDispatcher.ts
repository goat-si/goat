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
  CHANNEL_HOST_WORKSPACE_LABEL,
  CHANNEL_RECEPTION_MAX_OPTIONS,
  type ChannelDispatchTarget,
  type ChannelTask,
  type ChannelTaskId,
  type MemoryTaskGrantCeiling,
  type ModelSelection,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProjectId,
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
import { lowerRuntimeMode } from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRemoteWorkers from "./ChannelRemoteWorkers.ts";
import { type ChannelBotFiles, channelBotFilesFor } from "./channelBotNotes.ts";
import { answerForwardIdsFor, questionIdFor, workerLaunchIdsFor } from "./channelIds.ts";
import { choosePlacement, type PlacementCandidate } from "./channelPlacement.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import { channelWorkerRules, workerHeader } from "./channelWorkerBrief.ts";
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
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const remoteWorkers = yield* ChannelRemoteWorkers.ChannelRemoteWorkers;
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

  /**
   * The project choice to offer when none was named: the project of the most recently active
   * thread first, then the others, then the bot's workspace for work about the machine itself.
   */
  const projectChoices = (
    allowed: ReadonlyArray<{ readonly id: string; readonly title: string }>,
    hostWorkspace: boolean,
  ) =>
    Effect.gen(function* () {
      const recent = yield* threads
        .listProjectThreads({ projectId: undefined, includeSubagents: false })
        .pipe(Effect.orElseSucceed(() => []));
      const allowedIds = new Set(allowed.map((shell) => shell.id));
      const recentFirst: ReadonlyArray<string> = [
        ...new Set(
          recent
            .filter((shell) => shell.archivedAt === null && allowedIds.has(shell.projectId))
            .map((shell) => shell.projectId),
        ),
      ];
      const ordered = [
        ...recentFirst.flatMap((id) => allowed.filter((shell) => shell.id === id)),
        ...allowed.filter((shell) => !recentFirst.includes(shell.id)),
      ];
      const room = CHANNEL_RECEPTION_MAX_OPTIONS - (hostWorkspace ? 1 : 0);
      const choices = [
        ...ordered.slice(0, room).map((shell) => shell.title),
        ...(hostWorkspace ? [CHANNEL_HOST_WORKSPACE_LABEL] : []),
      ];
      const recommended = recentFirst.length > 0 ? ordered[0]?.title : undefined;
      const text =
        "Which project should I use?" +
        (recommended === undefined
          ? ""
          : " I'd go with " + recommended + ", where you worked most recently.") +
        (ordered.length > room
          ? " All projects: " + ordered.map((shell) => shell.title).join(", ")
          : "");
      return { type: "question" as const, text, choices };
    });

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
  const placeLocally = (selection: ModelSelection) =>
    Effect.gen(function* () {
      const configured = yield* providers.getInstance(selection.instanceId);
      if (configured === undefined) return { modelSelection: selection, reason: undefined };
      const siblings = (yield* providers.listInstances).filter(
        (instance) =>
          instance.instanceId === selection.instanceId ||
          (instance.enabled && instance.driverKind === configured.driverKind),
      );
      const load = yield* localTasksByInstance;
      const candidates = yield* Effect.forEach(siblings, (instance) =>
        Effect.gen(function* () {
          const snapshot = yield* instance.snapshot.getSnapshot;
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
          if (!isConfigured && !(ready && offers)) return [];
          const windows = snapshot.usageLimits?.windows ?? [];
          const candidate: PlacementCandidate<ModelSelection> = {
            value: isConfigured ? selection : { ...selection, instanceId: instance.instanceId },
            host: null,
            providerLabel:
              instance.displayName ?? snapshot.displayName ?? String(instance.instanceId),
            preferred: isConfigured,
            windows: windows.length === 0 ? null : windows,
            activeTasks: load.get(instance.instanceId) ?? 0,
          };
          return [candidate];
        }),
      );
      // listInstances leaves out instances that failed to start; the configured one still runs.
      const pool = candidates.flat();
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const placed = choosePlacement(
        pool.length === 0
          ? [
              {
                value: selection,
                host: null,
                providerLabel: String(selection.instanceId),
                preferred: true,
                windows: null,
                activeTasks: 0,
              },
            ]
          : pool,
        now,
      );
      return { modelSelection: placed?.chosen.value ?? selection, reason: placed?.reason };
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
      if (task.originAddress.kind === "slack") {
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
  const resolveTarget = (stored: ChannelLedger.ChannelStoredTask) =>
    Effect.gen(function* () {
      const task = stored.task;
      const bot = yield* ledger.getBot(stored.ownerId);
      const shells = yield* projects.listShells().pipe(Effect.orElseSucceed(() => []));
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
      const settings = resolveProjectSettings(
        yield* serverSettings.getSettings.pipe(Effect.orDie),
        chosen.id,
      ).settings;
      const projectModel =
        chosen.defaultModelSelection ??
        settings.defaultModelSelection ??
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
      if (!(yield* modelOffered(modelSelection))) {
        return {
          type: "question" as const,
          text:
            "The model for " +
            chosen.title +
            " is not available. Pick a default model for it in GOAT and answer here.",
        };
      }
      const isGit = yield* fileSystem
        .exists(path.join(chosen.workspaceRoot, ".git"))
        .pipe(Effect.orElseSucceed(() => false));
      const memoryGrantCeiling = yield* requesterMemoryCeiling(task);
      const placed = yield* placeLocally(modelSelection);
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
      return { type: "target" as const, target };
    });

  const launch = (stored: ChannelLedger.ChannelStoredTask, owner: string) =>
    Effect.gen(function* () {
      const task = stored.task;
      const target = task.target;
      if (target === undefined) return;
      const ids = workerLaunchIdsFor(task.taskId, task.generation);
      // The project's standing instructions go in front, as goat_thread_launch puts them, so a
      // channel worker follows the rules every thread in that project follows.
      const standing = resolveProjectSettings(
        yield* serverSettings.getSettings.pipe(Effect.orDie),
        target.projectId,
      ).settings.standingInstructions;
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
            text: prependStandingInstructions(standing, workerInstruction(task, botFiles)).text,
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
      const settings = resolveProjectSettings(
        yield* serverSettings.getSettings.pipe(Effect.orDie),
        named?.id ?? null,
      ).settings;
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

  const dispatch: ChannelDispatcher["Service"]["dispatch"] = (taskId, owner) =>
    Effect.gen(function* () {
      const stored = yield* ledger.getTask(taskId);
      if (stored === undefined) return;
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
      if (stored.task.host !== undefined) {
        return yield* remoteWorkers.dispatch(taskId, owner, yield* remoteHints(stored));
      }
      const resolved = yield* resolveTarget(stored);
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
        { owner },
      );
      if (claimed === undefined) return;
      const reread = yield* ledger.getTask(taskId);
      if (reread !== undefined) yield* launch(reread, owner);
    });

  const forward: ChannelDispatcher["Service"]["forward"] = (pending, owner) =>
    Effect.gen(function* () {
      const event = pending.event;
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

export const layer = Layer.effect(ChannelDispatcher, make);
