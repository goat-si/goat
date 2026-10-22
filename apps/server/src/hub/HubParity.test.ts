import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceConfigMap,
  ServerProvider,
  type ServerSettings,
  EnvironmentId,
  OrchestratorMcpFailure,
  type GoatHostStatusResult,
  type OpenCodexInventorySnapshot,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as HostThreads from "../mcp/HostThreadsMcpService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Inventory from "../opencodex/OpenCodexInventory.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Settings from "../serverSettings.ts";
import * as HubParity from "./HubParity.ts";
import { fleetSnapshot } from "./parity.testkit.ts";

const decodeProviderInstances = Schema.decodeUnknownEffect(ProviderInstanceConfigMap);
const decodeProvider = Schema.decodeUnknownEffect(ServerProvider);

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("hub-fixture"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "hub-test",
  thread: undefined,
  client: { sessionId: "test", label: "Test client", access: "full-access" },
};

const setup = Effect.fn("HubParityTest.setup")(function* (
  options: {
    home?: OpenCodexInventorySnapshot;
    remote?: GoatHostStatusResult;
    failure?: OrchestratorMcpFailure;
    scheduler?: boolean;
    hubEnabled?: boolean;
    providerInstances?: ServerSettings["providerInstances"];
    providers?: ReadonlyArray<ServerProvider>;
  } = {},
) {
  const calls = yield* Queue.unbounded<string>();
  const hubEnabled = yield* Ref.make(options.hubEnabled ?? true);
  const home = options.home ?? fleetSnapshot("home");
  const device = fleetSnapshot("mac-studio");
  const context = yield* Layer.build(
    HubParity.layer.pipe(
      Layer.provide(Layer.mock(Inventory.OpenCodexInventory)({ readParity: Effect.succeed(home) })),
      Layer.provide(
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed(options.providers ?? []),
        }),
      ),
      Layer.provide(
        Layer.mock(Settings.ServerSettingsService)({
          getSettings: Ref.get(hubEnabled).pipe(
            Effect.map((enabled) => ({
              ...DEFAULT_SERVER_SETTINGS,
              hub: { ...DEFAULT_SERVER_SETTINGS.hub, enabled },
              providerInstances: options.providerInstances ?? {},
            })),
          ),
        }),
      ),
      Layer.provide(Layer.succeed(HostProcess.Environment, {})),
      Layer.provide(
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(scope.environmentId),
        }),
      ),
      Layer.provide(
        options.scheduler
          ? Scheduler.layer
          : Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
      ),
      Layer.provide(
        Layer.mock(HostThreads.HostThreadsMcpService)({
          readOnHost: (_scope, input, decode) =>
            Effect.gen(function* () {
              expect(input.tool).toBe("goat_host_status");
              expect(input.arguments).toEqual({ local: true, parityEvidence: true });
              expect(input.timeoutMs).toBe(10_000);
              yield* Queue.offer(calls, input.host);
              if (options.failure) return yield* options.failure;
              return yield* decode(
                options.remote ?? {
                  hosts: [
                    {
                      host: null,
                      reachability: "ok",
                      metrics: {
                        sampledAt: 0,
                        cpuCount: 1,
                        cpuUtilization: 0,
                        totalMemoryBytes: 1,
                        availableMemoryBytes: 1,
                        loadAvg: null,
                        disk: null,
                        threads: { running: 0, waiting: 0, queued: 0 },
                        quotas: [],
                        opencodex: device,
                      },
                    },
                  ],
                },
              ).pipe(
                Effect.map((result) => ({ ...result, host: input.host })),
                Effect.mapError(
                  () =>
                    new OrchestratorMcpFailure({
                      code: "orchestration_error",
                      message: "Invalid fixture",
                    }),
                ),
              );
            }),
        }),
      ),
    ),
  );
  return { parity: Context.get(context, HubParity.HubParity), calls, hubEnabled };
});

it.effect("verify reads the device through host status and caches the Home-relative verdict", () =>
  Effect.gen(function* () {
    const { parity, calls } = yield* setup();
    const result = yield* parity.verify("mac-studio", scope);
    expect(yield* Queue.take(calls)).toBe("mac-studio");
    expect(result.verdict).toBe("unproven");
    expect(result.failingCheckIds).toEqual([]);
    expect(yield* parity.latest("mac-studio")).toEqual(result);
  }),
);

it.effect("stale and missing remote samples cannot prove a healthy device", () =>
  Effect.gen(function* () {
    for (const remote of [
      { hosts: [] },
      { hosts: [{ host: null, reachability: "unreachable" as const, lastKnown: true as const }] },
    ]) {
      const { parity } = yield* setup({ remote });
      const result = yield* parity.verify("mac-studio", scope);
      expect(result.verdict).toBe("broken");
      expect(result.failingCheckIds).toContain("P1");
    }
  }),
);

it.effect("remote authorization failures remain failures instead of a parity verdict", () =>
  Effect.gen(function* () {
    const { parity } = yield* setup({
      failure: new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "Fixture refusal",
      }),
    });
    const result = yield* parity.verify("mac-studio", scope).pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    expect(yield* parity.latest("mac-studio")).toBeUndefined();
  }),
);

it.effect("the existing Scheduler verifies Home links at startup and every 30 minutes", () =>
  Effect.gen(function* () {
    const home = fleetSnapshot("home");
    const { parity, calls } = yield* setup({
      home: {
        ...home,
        link: {
          ...home.link,
          links: home.link.links.filter(({ alias }) => alias === "mac-studio"),
        },
      },
      scheduler: true,
    });
    expect(yield* Queue.take(calls)).toBe("mac-studio");
    yield* TestClock.adjust("29 minutes");
    expect(yield* Queue.size(calls)).toBe(0);
    yield* TestClock.adjust("1 minute");
    expect(yield* Queue.take(calls)).toBe("mac-studio");
    expect((yield* parity.latest("mac-studio"))?.checkedAt).toBe(30 * 60 * 1000);
  }),
);

it.effect("a Child never schedules verifications of its Home-owned fleet", () =>
  Effect.gen(function* () {
    const { calls } = yield* setup({ home: fleetSnapshot("mac-studio"), scheduler: true });
    yield* TestClock.adjust("31 minutes");
    expect(yield* Queue.size(calls)).toBe(0);
  }),
);

it.effect("the sweep waits for hub.enabled and verifies as soon as it is turned on", () =>
  Effect.gen(function* () {
    const home = fleetSnapshot("home");
    const { calls, hubEnabled } = yield* setup({
      home: {
        ...home,
        link: { ...home.link, links: home.link.links.filter(({ alias }) => alias === "lidge-ts") },
      },
      scheduler: true,
      hubEnabled: false,
    });
    yield* TestClock.adjust("31 minutes");
    expect(yield* Queue.size(calls)).toBe(0);
    yield* Ref.set(hubEnabled, true);
    yield* TestClock.adjust("1 minute");
    expect(yield* Queue.take(calls)).toBe("lidge-ts");
  }),
);

it.effect.each([true, false])(
  "checks Codex effective config, Claude environment, and OpenCode inline provider (local=%s)",
  (local) =>
    Effect.gen(function* () {
      const base = local ? "http://127.0.0.1:10100" : "https://outside.example";
      const providerInstances = yield* decodeProviderInstances({
        codex: { driver: "codex" },
        claude: {
          driver: "claudeAgent",
          environment: [{ name: "ANTHROPIC_BASE_URL", value: base }],
        },
        opencode: {
          driver: "opencode",
          environment: [
            {
              name: "OPENCODE_CONFIG_CONTENT",
              value: JSON.stringify({
                model: "opencodex/example",
                provider: { opencodex: { options: { baseURL: `${base}/v1` } } },
              }),
            },
          ],
        },
        cloud: { driver: "claudeCloud" },
        disabled: { driver: "claudeAgent", config: { enabled: false } },
      });
      const provider = yield* decodeProvider({
        instanceId: "codex",
        driver: "codex",
        enabled: true,
        installed: true,
        version: "fixture",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-10-21T00:00:00.000Z",
        models: [],
        codexRoute: { modelRoute: "opencodex", state: "connected", effectiveBaseUrl: `${base}/v1` },
      });
      const { parity } = yield* setup({ providerInstances, providers: [provider] });
      const result = yield* parity.readLocal;
      expect(result.parityEvidence?.wiring?.map(({ status }) => status)).toEqual(
        Array(3).fill(local ? "ok" : "failed"),
      );
      expect(JSON.stringify(result)).not.toContain("outside.example");
    }),
);

it.effect(
  "inspect-only connected and an OpenCode user config do not prove effective client wiring",
  () =>
    Effect.gen(function* () {
      const providerInstances = yield* decodeProviderInstances({
        codex: { driver: "codex" },
        opencode: { driver: "opencode" },
      });
      const provider = yield* decodeProvider({
        instanceId: "codex",
        driver: "codex",
        enabled: true,
        installed: true,
        version: "fixture",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-10-21T00:00:00.000Z",
        models: [],
        codexRoute: { modelRoute: "opencodex", state: "connected" },
      });
      const { parity } = yield* setup({ providerInstances, providers: [provider] });
      expect((yield* parity.readLocal).parityEvidence?.wiring?.map(({ status }) => status)).toEqual(
        ["unproven", "unproven"],
      );
    }),
);
