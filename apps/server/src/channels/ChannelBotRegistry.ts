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
 * @module ChannelBotRegistry
 */
import {
  type ChannelBotRef,
  type ChannelEnsureBotInput,
  ChannelGatewayError,
  type ChannelGetBotStatusResult,
  type ThreadId,
} from "@t3tools/contracts";
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
import { botLaunchIdsFor } from "./channelIds.ts";

const GOAT_BOT_TITLE = "GOAT bot";

const ACTIVE_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export class ChannelBotRegistry extends Context.Service<
  ChannelBotRegistry,
  {
    readonly ensure: (
      input: ChannelEnsureBotInput,
      owner: ChannelConnectionOwner,
    ) => Effect.Effect<ChannelBotRef, ChannelGatewayError>;
    /**
     * The stored bot and its waiting count, read without creating anything, so a client that
     * never opens the bot still knows which thread it is. Answers on any server, home or not.
     */
    readonly status: (
      owner: ChannelConnectionOwner,
    ) => Effect.Effect<ChannelGetBotStatusResult, ChannelGatewayError>;
  }
>()("t3/channels/ChannelBotRegistry") {}

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
          ? { type: "adopt" as const, projectId: thread.projectId }
          : { type: "legacy" as const };
      }),
      // A thread this server does not know is just a stale client cache.
      Effect.catch(() => Effect.succeed({ type: "ignore" as const })),
    );

  /** Whether a stored bot thread was deleted. Read failures keep the stored bot. */
  const wasDeleted = (threadId: ThreadId) =>
    threads.getThreadRecords(threadId, ["runs"]).pipe(
      Effect.map((records) => records.thread.deletedAt !== null),
      Effect.catch(() => Effect.succeed(false)),
    );

  /** Starts a bot thread in the bot's project. Ids are fixed per owner and replaced thread. */
  const launchBot = (owner: ChannelConnectionOwner, replacing?: ThreadId) =>
    Effect.gen(function* () {
      const environmentId = yield* environment.getEnvironmentId;
      const project = yield* folders.ensureBotProject.pipe(
        Effect.tapError((cause) => Effect.logWarning("GOAT bot project failed", { cause })),
        Effect.mapError(persistence),
      );
      const settings = yield* serverSettings.getSettings.pipe(Effect.mapError(persistence));
      const ids = botLaunchIdsFor(owner.ownerId, replacing);
      // No initial message: the bot thread exists only to hold the conversation and chips.
      const launched = yield* launches
        .launch({
          commandId: ids.commandId,
          threadId: ids.threadId,
          projectId: project.projectId,
          title: GOAT_BOT_TITLE,
          modelSelection: settings.textGenerationModelSelection,
          runtimeMode: "approval-required",
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

  const ensure: ChannelBotRegistry["Service"]["ensure"] = (input, owner) =>
    Effect.gen(function* () {
      yield* home.requireHome;
      const existing = yield* ledger.getBot(owner.ownerId).pipe(Effect.mapError(persistence));
      const now = DateTime.formatIso(yield* DateTime.now);
      if (existing !== undefined) {
        const previousThreadId = existing.bot.threadId;
        if (!(yield* wasDeleted(previousThreadId))) return existing.bot;
        const bot = yield* launchBot(owner, previousThreadId);
        return yield* ledger
          .replaceBot({ ownerId: owner.ownerId, previousThreadId, bot, now })
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
        return yield* ledger
          .setBotIfAbsent({
            ownerId: owner.ownerId,
            bot: {
              environmentId,
              projectId: candidate.projectId,
              threadId: input.candidateThreadId,
            },
            now,
          })
          .pipe(Effect.mapError(persistence));
      }
      const bot = yield* launchBot(owner);
      return yield* ledger
        .setBotIfAbsent({
          ownerId: owner.ownerId,
          bot,
          ...(candidate.type === "legacy" && input.candidateThreadId !== undefined
            ? { legacyThreadId: input.candidateThreadId }
            : {}),
          now,
        })
        .pipe(Effect.mapError(persistence));
    });

  const status: ChannelBotRegistry["Service"]["status"] = (owner) =>
    Effect.all({
      bot: ledger.getBot(owner.ownerId).pipe(Effect.map((stored) => stored?.bot ?? null)),
      waitingCount: ledger.countWaitingGoatTasks(owner.ownerId),
    }).pipe(Effect.mapError(persistence));

  return ChannelBotRegistry.of({ ensure, status });
});

export const layer = Layer.effect(ChannelBotRegistry, make);
