import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OpenCodexInventorySnapshot,
  type OrchestrationV2ServerCommand,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as Inbox from "../goatclaw/DecisionInbox.ts";
import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import * as PendingQuestions from "../mcp/PendingQuestionsMcpService.ts";
import * as Inventory from "../opencodex/OpenCodexInventory.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import { HubDown, layer as hubDownLayer, type PausedGoalWork } from "./HubDown.ts";

const routed = ProviderInstanceId.make("codex");
const own = ProviderInstanceId.make("codex-own");
const selection = { instanceId: routed, model: "gpt-6.1-sol" };
const owner: Inbox.DecisionCaller = {
  kind: "client",
  sessionId: "owner",
  environmentId: EnvironmentId.make("test"),
  scopes: ["orchestration:operate", "settings:write"],
};

const provider = (instanceId: ProviderInstanceId, effectiveBaseUrl: string) =>
  ({
    instanceId,
    driver: "codex",
    enabled: true,
    status: "ready",
    auth: { status: "authenticated" },
    codexRoute: { modelRoute: "default", effectiveBaseUrl },
    models: [{ slug: "gpt-6.1-sol", name: "GPT 6.1 Sol", isCustom: false }],
  }) as unknown as ServerProvider;

const child = (
  modelsStatus: number,
  fallback?: OpenCodexInventorySnapshot["fallback"],
): OpenCodexInventorySnapshot => ({
  installed: true,
  binaries: [],
  ownership: "adopted",
  service: { available: false },
  runtime: { port: 10100, healthy: true, ready: true, role: "client" },
  link: { role: "child", available: true, links: [], childSettingsApplied: true },
  parityEvidence: { observedAt: 0, modelsStatus },
  ...(fallback === undefined ? {} : { fallback }),
});

interface Fake {
  current: OpenCodexInventorySnapshot;
  parityReads: number;
  readonly commands: Array<OrchestrationV2ServerCommand>;
}

const layerFor = (fake: Fake, localFallback = true) => {
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    dispatch: (command) =>
      Effect.sync(() => {
        fake.commands.push(command);
        return {} as never;
      }),
  });
  return hubDownLayer.pipe(
    Layer.provideMerge(Inbox.layer),
    Layer.provide(Profiles.layer),
    Layer.provide(Layer.mock(PendingQuestions.PendingQuestionsMcpService)({})),
    Layer.provide(threads),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          Inventory.OpenCodexInventory,
          Inventory.OpenCodexInventory.of({
            read: Effect.sync(() => fake.current),
            readParity: Effect.sync(() => {
              fake.parityReads += 1;
              return fake.current;
            }),
          }),
        ),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([
            provider(routed, "http://127.0.0.1:10100/v1"),
            provider(own, "https://api.openai.com/v1"),
          ]),
        }),
        Layer.succeed(HostProcess.Hostname, "macmini-ts"),
      ),
    ),
    Layer.provideMerge(
      Settings.layerTest({
        goatclaw: { enabled: true },
        providerInstances: { [routed]: { driver: "codex" }, [own]: { driver: "codex" } },
        hub: { devices: { local: { localFallback } } },
      }),
    ),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provide(NodeCrypto.layer),
  );
};

const makeFake = (current: OpenCodexInventorySnapshot): Fake => ({
  current,
  parityReads: 0,
  commands: [],
});

const pausedWork = (goalId: string, message: string): PausedGoalWork => ({
  goalId,
  title: "Ship " + goalId,
  ownerThreadId: ThreadId.make("owner"),
  instanceId: routed,
  message,
});

describe("HubDown", () => {
  it.effect(
    "files one decision while goal work is paused and withdraws it once the Home answers",
    () => {
      const fake = makeFake(child(503, { source: "local" }));
      return Effect.gen(function* () {
        const hub = yield* HubDown;
        const inbox = yield* Inbox.DecisionInbox;
        // The Home was never read, so OpenCodex's permission is unknown and the work pauses.
        const work = yield* hub.forWork(selection);
        expect(work._tag).toBe("Paused");
        const message = work._tag === "Paused" ? work.message : "";
        expect(message).toContain("unknown");

        yield* hub.settle([pausedWork("goal_a", message)]);
        yield* TestClock.adjust("2 minutes");
        yield* hub.settle([pausedWork("goal_b", message), pausedWork("goal_a", message)]);
        const open = (yield* inbox.list(owner, { status: "open" })).items;
        expect(open).toHaveLength(1);
        expect(open[0]).toMatchObject({
          title: "Hub unreachable: goal work on macmini-ts is paused",
          from: { threadId: "owner" },
          recommended: "wait",
          requiredProfile: "manager",
        });
        expect(open[0]!.options.map((option) => option.id)).toEqual(["wait"]);

        fake.current = child(200, { source: "home" });
        yield* TestClock.adjust("2 minutes");
        yield* hub.settle([]);
        expect((yield* inbox.list(owner, { status: "open" })).items).toEqual([]);
        expect((yield* inbox.list(owner, { status: "withdrawn" })).items).toHaveLength(1);
        expect((yield* hub.forWork(selection))._tag).toBe("Unaffected");
      }).pipe(Effect.provide(layerFor(fake)));
    },
  );

  it.effect(
    "hops on the permission the Home gave before its outage, reading at most once a minute",
    () => {
      const fake = makeFake(child(200, { source: "home", localFallback: true }));
      return Effect.gen(function* () {
        const hub = yield* HubDown;
        expect((yield* hub.forWork(selection))._tag).toBe("Unaffected");
        // Down now, but the last read is still fresh.
        fake.current = child(503, { source: "local" });
        expect((yield* hub.forWork(selection))._tag).toBe("Unaffected");
        expect(fake.parityReads).toBe(1);

        yield* TestClock.adjust("1 minute");
        const work = yield* hub.forWork(selection);
        expect(work).toMatchObject({ _tag: "Hop", selection: { instanceId: own } });
        expect(fake.parityReads).toBe(2);
        yield* hub.notice(ThreadId.make("worker"), "goal:a:s0:a1:launch", "moved");
        expect(fake.commands).toMatchObject([
          { type: "thread.notice.record", threadId: "worker", message: "moved" },
        ]);
      }).pipe(Effect.provide(layerFor(fake)));
    },
  );

  it.effect(
    "pauses when GOAT's switch for this device is off, even with OpenCodex's permission",
    () => {
      const fake = makeFake(child(200, { source: "home", localFallback: true }));
      return Effect.gen(function* () {
        const hub = yield* HubDown;
        yield* hub.forWork(selection);
        fake.current = child(503, { source: "local" });
        yield* TestClock.adjust("1 minute");
        const work = yield* hub.forWork(selection);
        expect(work._tag === "Paused" && work.message).toContain("local fallback is off");
      }).pipe(Effect.provide(layerFor(fake, false)));
    },
  );

  it.effect("never makes the relayed request on a device that is not linked to a Home", () => {
    const fake = makeFake({
      ...child(503),
      link: { role: "none", available: true, links: [], childSettingsApplied: null },
    });
    return Effect.gen(function* () {
      const hub = yield* HubDown;
      expect((yield* hub.forWork(selection))._tag).toBe("Unaffected");
      yield* hub.settle([]);
      expect(fake.parityReads).toBe(0);
    }).pipe(Effect.provide(layerFor(fake)));
  });
});
