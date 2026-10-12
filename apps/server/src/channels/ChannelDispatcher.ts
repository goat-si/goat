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
  type ChannelTask,
  type ChannelTaskId,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProjectId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import {
  type DispatchModeRefusal,
  DispatchModeLimit,
} from "../orchestration-v2/DispatchModeLimit.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import { lowerRuntimeMode } from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRemoteWorkers from "./ChannelRemoteWorkers.ts";
import { answerForwardIdsFor, questionIdFor, workerLaunchIdsFor } from "./channelIds.ts";
import { commitTransition } from "./channelTaskWrites.ts";

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
>()("t3/channels/ChannelDispatcher") {}

/** What the worker thread is told besides the instruction itself. */
const workerInstruction = (task: ChannelTask) =>
  [
    task.instruction,
    "",
    "---",
    "This work came in through GOAT as task " +
      task.taskId +
      " (generation " +
      task.generation +
      ").",
    'If you need a decision from the person who asked, call channel_task_report with this taskId and generation, status "waiting_input", a new eventId, and your question, then stop.',
    "When you finish, end with a short summary of the result.",
  ].join("\n");

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

  const askRequester = (
    stored: ChannelLedger.ChannelStoredTask,
    text: string,
    owner: string,
    options: { readonly clearPendingAnswer?: boolean } = {},
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

  /** The launch settings for a task, or the question to ask when they cannot be chosen. */
  const resolveTarget = (stored: ChannelLedger.ChannelStoredTask) =>
    Effect.gen(function* () {
      const task = stored.task;
      const bot = yield* ledger.getBot(stored.ownerId);
      const shells = yield* projects.listShells().pipe(Effect.orElseSucceed(() => []));
      const real = shells.filter((shell) => shell.id !== bot?.bot.projectId);
      const allowed = real.length > 0 ? real : shells;
      const names = allowed.map((shell) => shell.title).join(", ");
      let chosen = allowed.find((shell) => shell.id === task.projectId);
      if (task.projectId !== undefined && chosen === undefined) {
        return {
          type: "question" as const,
          text: "I can't start work in that project. Which one should I use? " + names,
        };
      }
      if (chosen === undefined && allowed.length === 1) chosen = allowed[0];
      if (chosen === undefined) {
        return {
          type: "question" as const,
          text:
            allowed.length === 0
              ? "There is no project to work in yet. Add one in GOAT, then answer with its name."
              : "Which project should I use? " + names,
        };
      }
      const settings = resolveProjectSettings(
        yield* serverSettings.getSettings.pipe(Effect.orDie),
        chosen.id,
      ).settings;
      const modelSelection =
        chosen.defaultModelSelection ??
        settings.defaultModelSelection ??
        settings.textGenerationModelSelection;
      const instance = yield* providers.getInstance(modelSelection.instanceId);
      if (instance === undefined) {
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
      const target: ChannelDispatchTarget = {
        environmentId: yield* environment.getEnvironmentId,
        projectId: chosen.id,
        modelSelection,
        runtimeMode: lowerRuntimeMode(
          task.requester.runtimeModeCeiling,
          settings.defaultRuntimeMode,
        ),
        interactionMode: "default",
        // Each task in a repository gets its own worktree so two tasks never share a checkout.
        workspaceStrategy: isGit ? { type: "worktree", baseRef: "HEAD" } : { type: "root" },
      };
      return { type: "target" as const, target };
    });

  const launch = (stored: ChannelLedger.ChannelStoredTask, owner: string) =>
    Effect.gen(function* () {
      const task = stored.task;
      const target = task.target;
      if (target === undefined) return;
      const ids = workerLaunchIdsFor(task.taskId, task.generation);
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
            text: workerInstruction(task),
            attachments: [],
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
      const shells = yield* projects.listShells().pipe(Effect.orElseSucceed(() => []));
      const named = shells.find((shell) => shell.id === task.projectId);
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
      return {
        modelSelection:
          named?.defaultModelSelection ??
          settings.defaultModelSelection ??
          settings.textGenerationModelSelection,
        runtimeMode: lowerRuntimeMode(
          task.requester.runtimeModeCeiling,
          settings.defaultRuntimeMode,
        ),
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
      if (resolved.type === "question") return yield* askRequester(stored, resolved.text, owner);
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
