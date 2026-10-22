/**
 * ChannelBotRegistry - finds or creates the canonical GOAT bot thread for the host owner.
 *
 * The server decides which thread is the bot; clients only cache the answer. A stopped legacy
 * global agent with no runs is adopted as is. One with history keeps that history and a new bot
 * starts next to it, because runless bot messages sort before old runs and would read out of
 * order. A running legacy agent is left alone and reported as `legacy_active`. When the bot
 * thread itself was deleted, the next call starts a new bot and records it in its place; an
 * archived bot stays the bot, since unarchiving brings it back.
 *
 * The bot always runs with full access and is read-only by its instructions, not its sandbox.
 * A bot made while it ran approval-required is switched in place, keeping its history.
 *
 * @module ChannelBotRegistry
 */
import {
  type ChannelBotRef,
  type ChannelEnsureBotInput,
  ChannelGatewayError,
  type ChannelGetBotStatusResult,
  type RuntimeMode,
  type ThreadId,
  type EnvironmentId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { ChannelConnectionOwner } from "./ChannelIngressContext.ts";
import * as ChannelBotHome from "./ChannelBotHome.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import { channelOwnerIdFor } from "./channelOwner.ts";
import { botFullAccessCommandIdFor, botLaunchIdsFor } from "./channelIds.ts";

const GOAT_BOT_TITLE = "GOAT bot";

const GOAT_BOT_RUNTIME_MODE = "full-access" satisfies RuntimeMode;

const ACTIVE_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export class ChannelBotRegistry extends Context.Service<
  ChannelBotRegistry,
  {
    readonly ensure: (
      input: ChannelEnsureBotInput,
      owner: ChannelConnectionOwner,
    ) => Effect.Effect<ChannelBotRef, ChannelGatewayError>;
    /** Internal memory delivery: canonical local bot without changing the cluster home. */
    readonly ensureForReport: (
      owner: EnvironmentId,
    ) => Effect.Effect<ChannelBotRef, ChannelGatewayError>;
    /**
     * The stored bot and its waiting count, read without creating anything, so a client that
     * never opens the bot still knows which thread it is. Answers on any server, home or not.
     */
    readonly status: (
      owner: ChannelConnectionOwner,
    ) => Effect.Effect<ChannelGetBotStatusResult, ChannelGatewayError>;
  }
>()("goat/channels/ChannelBotRegistry") {}

const persistence = () => new ChannelGatewayError({ reason: "persistence_failed" });

const make = Effect.gen(function* () {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const home = yield* ChannelBotHome.ChannelBotHome;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;

  /** What to do with a client's cached global agent: adopt it, keep it as legacy, or refuse. */
  const inspectCandidate = (threadId: ThreadId) =>
    threads.getThreadRecords(threadId, ["runs"]).pipe(
      Effect.map((records) => {
        const thread = records.thread;
        if (thread.archivedAt !== null || thread.deletedAt !== null)
          return { type: "ignore" as const };
        if (records.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status))) {
          return { type: "active" as const };
        }
        return records.runs.length === 0
          ? {
              type: "adopt" as const,
              projectId: thread.projectId,
              runtimeMode: thread.runtimeMode,
            }
          : { type: "legacy" as const };
      }),
      // A thread this server does not know is just a stale client cache.
      Effect.catch(() => Effect.succeed({ type: "ignore" as const })),
    );

  /** A stored bot thread's deletion and runtime mode. A read failure keeps the stored bot as is. */
  const inspectStored = (threadId: ThreadId) =>
    threads.getThreadRecords(threadId, []).pipe(
      Effect.map((records) => ({
        deleted: records.thread.deletedAt !== null,
        runtimeMode: records.thread.runtimeMode,
      })),
      Effect.orElseSucceed(() => undefined),
    );

  /** A failed switch only logs: the bot still answers, and the next ensure tries again. */
  const ensureFullAccess = (threadId: ThreadId, runtimeMode: RuntimeMode, now: string) =>
    runtimeMode === GOAT_BOT_RUNTIME_MODE
      ? Effect.void
      : threads
          .dispatch({
            type: "thread.runtime-mode.set",
            commandId: botFullAccessCommandIdFor(threadId, now),
            threadId,
            runtimeMode: GOAT_BOT_RUNTIME_MODE,
          })
          .pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("GOAT bot full access switch failed", { cause }),
            ),
            Effect.ignore,
          );

  /** Starts a bot thread in the bot's project. Ids are fixed per owner and replaced thread. */
  const launchBot = (ownerId: string, replacing?: ThreadId) =>
    Effect.gen(function* () {
      const environmentId = yield* environment.getEnvironmentId;
      const project = yield* folders.ensureBotProject.pipe(
        Effect.tapError((cause) => Effect.logWarning("GOAT bot project failed", { cause })),
        Effect.mapError(persistence),
      );
      const settings = yield* serverSettings.getSettings.pipe(Effect.mapError(persistence));
      const ids = botLaunchIdsFor(ownerId, replacing);
      // No initial message: the bot thread exists only to hold the conversation and chips.
      const launched = yield* launches
        .launch({
          commandId: ids.commandId,
          threadId: ids.threadId,
          projectId: project.projectId,
          title: GOAT_BOT_TITLE,
          modelSelection: settings.textGenerationModelSelection,
          runtimeMode: GOAT_BOT_RUNTIME_MODE,
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          createdBy: "system",
          creationSource: "server",
        })
        .pipe(
          Effect.tapError((cause) => Effect.logWarning("GOAT bot launch failed", { cause })),
          Effect.mapError(persistence),
        );
      return { environmentId, projectId: project.projectId, threadId: launched.threadId };
    });

  const ensureCanonical = (input: ChannelEnsureBotInput, ownerId: string) =>
    Effect.gen(function* () {
      const existing = yield* ledger.getBot(ownerId).pipe(Effect.mapError(persistence));
      const now = DateTime.formatIso(yield* DateTime.now);
      if (existing !== undefined) {
        const previousThreadId = existing.bot.threadId;
        const stored = yield* inspectStored(previousThreadId);
        if (stored?.deleted !== true) {
          if (stored !== undefined)
            yield* ensureFullAccess(previousThreadId, stored.runtimeMode, now);
          return existing.bot;
        }
        const bot = yield* launchBot(ownerId, previousThreadId);
        return yield* ledger
          .replaceBot({ ownerId, previousThreadId, bot, now })
          .pipe(Effect.mapError(persistence));
      }
      const environmentId = yield* environment.getEnvironmentId;
      const candidate =
        input.candidateThreadId === undefined
          ? ({ type: "ignore" } as const)
          : yield* inspectCandidate(input.candidateThreadId);
      if (candidate.type === "active") {
        return yield* new ChannelGatewayError({ reason: "legacy_active" });
      }
      if (candidate.type === "adopt" && input.candidateThreadId !== undefined) {
        const adopted = yield* ledger
          .setBotIfAbsent({
            ownerId,
            bot: {
              environmentId,
              projectId: candidate.projectId,
              threadId: input.candidateThreadId,
            },
            now,
          })
          .pipe(Effect.mapError(persistence));
        if (adopted.threadId === input.candidateThreadId)
          yield* ensureFullAccess(adopted.threadId, candidate.runtimeMode, now);
        return adopted;
      }
      const bot = yield* launchBot(ownerId);
      return yield* ledger
        .setBotIfAbsent({
          ownerId,
          bot,
          ...(candidate.type === "legacy" && input.candidateThreadId !== undefined
            ? { legacyThreadId: input.candidateThreadId }
            : {}),
          now,
        })
        .pipe(Effect.mapError(persistence));
    });

  const ensure: ChannelBotRegistry["Service"]["ensure"] = (input, owner) =>
    home.requireHome.pipe(Effect.andThen(ensureCanonical(input, owner.ownerId)));

  const ensureForReport: ChannelBotRegistry["Service"]["ensureForReport"] = (owner) =>
    Effect.gen(function* () {
      if (owner !== (yield* environment.getEnvironmentId))
        return yield* new ChannelGatewayError({ reason: "invalid_input" });
      // No candidate means a report can never adopt a user's active agent thread.
      return yield* ensureCanonical({}, channelOwnerIdFor(owner));
    });

  /**
   * The bot thread's visit watermark. Visiting the bot thread (thread.visit, the sidebar's
   * mark-read path) marks every task that was waiting by then as read.
   */
  const botReadThrough = (bot: ChannelBotRef | null) =>
    Effect.gen(function* () {
      if (bot === null || bot.environmentId !== (yield* environment.getEnvironmentId))
        return undefined;
      const records = yield* threads.getThreadRecords(bot.threadId, []);
      const visitedAt = records.thread.lastVisitedAt;
      return visitedAt === null ? undefined : DateTime.formatIso(visitedAt);
    }).pipe(Effect.orElseSucceed(() => undefined));

  const status: ChannelBotRegistry["Service"]["status"] = (owner) =>
    Effect.gen(function* () {
      const bot = (yield* ledger.getBot(owner.ownerId))?.bot ?? null;
      const readThrough = yield* botReadThrough(bot);
      const waitingCount = yield* ledger.countWaitingTasks(owner.ownerId, readThrough);
      return { bot, waitingCount };
    }).pipe(Effect.mapError(persistence));

  return ChannelBotRegistry.of({ ensure, ensureForReport, status });
});

export const layer = Layer.effect(ChannelBotRegistry, make);
