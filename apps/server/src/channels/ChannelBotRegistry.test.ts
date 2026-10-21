import { assert, describe, it } from "@effect/vitest";
import { CommandId, EnvironmentId, MessageId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Registry from "./ChannelBotRegistry.ts";
import * as Ledger from "./ChannelLedger.ts";
import * as Settings from "../serverSettings.ts";
import { botLaunchIdsFor } from "./channelIds.ts";
import {
  environmentId,
  makeHarness,
  owner,
  ownerId,
  setupBot,
  botThreadId,
  scratchProjectId,
  modelSelection,
} from "./testkit/ChannelHarness.ts";

const runtimeModeOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    return (yield* threads.getThreadRecords(threadId, [])).thread.runtimeMode;
  });

/** The thread's runtime mode updates so far, read up to a marker so the live stream ends. */
const runtimeModeUpdates = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const marker = yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("runtime-mode-updates-marker"),
      threadId,
      title: "GOAT bot (checked)",
    });
    return yield* orchestrator.streamStoredEventsFrom({ threadId }).pipe(
      Stream.takeUntil((stored) => stored.sequence >= marker.sequence),
      Stream.filter((stored) => stored.event.type === "thread.runtime-mode-updated"),
      Stream.runCollect,
    );
  });

describe("ChannelBotRegistry full access", () => {
  it.effect("starts a new bot with full access", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const registry = yield* Registry.ChannelBotRegistry;
      yield* registry.ensure({}, owner);
      assert.strictEqual(harness.world.launches.length, 1);
      assert.strictEqual(harness.world.launches[0]!.runtimeMode, "full-access");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("switches a bot made approval-required to full access in place, once", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const registry = yield* Registry.ChannelBotRegistry;
      assert.strictEqual(yield* runtimeModeOf(botThreadId), "approval-required");
      assert.strictEqual((yield* registry.ensure({}, owner)).threadId, botThreadId);
      assert.strictEqual(yield* runtimeModeOf(botThreadId), "full-access");
      assert.strictEqual((yield* registry.ensureForReport(environmentId)).threadId, botThreadId);
      assert.strictEqual((yield* registry.ensure({}, owner)).threadId, botThreadId);
      assert.strictEqual((yield* runtimeModeUpdates(botThreadId)).length, 1);
      assert.isEmpty(harness.world.launches);
      assert.isEmpty(harness.providerCalls);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("switches an adopted legacy agent to full access", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const registry = yield* Registry.ChannelBotRegistry;
      const legacy = ThreadId.make("legacy-agent");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("legacy-create"),
        threadId: legacy,
        projectId: scratchProjectId,
        title: "GOAT bot",
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "system",
        creationSource: "server",
      });
      assert.strictEqual(
        (yield* registry.ensure({ candidateThreadId: legacy }, owner)).threadId,
        legacy,
      );
      assert.strictEqual(yield* runtimeModeOf(legacy), "full-access");
      assert.isEmpty(harness.world.launches);
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("ChannelBotRegistry report owner", () => {
  it.effect("bypasses only the home gate and uses the public canonical owner", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const registry = yield* Registry.ChannelBotRegistry;
      const ledger = yield* Ledger.ChannelLedger;
      const home = {
        environmentId: EnvironmentId.make("other"),
        claimedAt: 1,
        claimId: "other-home",
      };
      yield* settings.updateSettings({ goatBotHome: home });
      assert.strictEqual((yield* Effect.flip(registry.ensure({}, owner))).reason, "not_home");
      const bot = yield* registry.ensureForReport(environmentId);
      assert.strictEqual(bot.threadId, botLaunchIdsFor(ownerId).threadId);
      assert.deepStrictEqual((yield* ledger.getBot(ownerId))!.bot, bot);
      assert.deepStrictEqual(yield* registry.ensureForReport(environmentId), bot);
      assert.deepStrictEqual((yield* settings.getSettings).goatBotHome, home);
      assert.strictEqual(harness.world.launches.length, 1);
      assert.isUndefined(harness.world.launches[0]!.initialMessage);
      assert.isEmpty(harness.world.sends);
      assert.isEmpty(harness.providerCalls);
      assert.strictEqual(
        (yield* Effect.flip(registry.ensureForReport(EnvironmentId.make("foreign")))).reason,
        "invalid_input",
      );
    }).pipe(Effect.provide(harness.layer));
  });
  it.effect(
    "reuses the canonical bot independently of home without creating another thread",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const registry = yield* Registry.ChannelBotRegistry;
        assert.strictEqual((yield* registry.ensureForReport(environmentId)).threadId, botThreadId);
        assert.deepStrictEqual(
          yield* registry.ensure({}, owner),
          yield* registry.ensureForReport(environmentId),
        );
        assert.isEmpty(harness.world.launches);
        assert.isEmpty(harness.providerCalls);
      }).pipe(Effect.provide(harness.layer));
    },
  );
  it.effect("report creation leaves an active legacy agent alone", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const registry = yield* Registry.ChannelBotRegistry;
      const active = ThreadId.make("active-agent");
      harness.world.addRun(active, MessageId.make("active-message"));
      assert.strictEqual(
        (yield* Effect.flip(registry.ensure({ candidateThreadId: active }, owner))).reason,
        "legacy_active",
      );
      const bot = yield* registry.ensureForReport(environmentId);
      assert.notStrictEqual(bot.threadId, active);
      assert.strictEqual(harness.world.latestRun(active)!.status, "running");
      assert.isEmpty(harness.world.sends);
      assert.isEmpty(harness.providerCalls);
    }).pipe(Effect.provide(harness.layer));
  });
  it.effect(
    "report ensure replaces a deleted canonical bot using the shared replacement path",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const registry = yield* Registry.ChannelBotRegistry;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const replacement = botLaunchIdsFor(ownerId, botThreadId).threadId;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("replacement-create"),
          threadId: replacement,
          projectId: scratchProjectId,
          title: "GOAT bot",
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "system",
          creationSource: "server",
        });
        yield* orchestrator.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("old-delete"),
          threadId: botThreadId,
        });
        assert.strictEqual((yield* registry.ensureForReport(environmentId)).threadId, replacement);
        assert.strictEqual((yield* registry.ensure({}, owner)).threadId, replacement);
        assert.strictEqual(harness.world.launches.length, 1);
        assert.isUndefined(harness.world.launches[0]!.initialMessage);
        assert.isEmpty(harness.providerCalls);
      }).pipe(Effect.provide(harness.layer));
    },
  );
});
