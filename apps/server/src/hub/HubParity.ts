import {
  GoatHostStatusResult,
  type HubParityResult,
  type OpenCodexInventorySnapshot,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as HostThreads from "../mcp/HostThreadsMcpService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Inventory from "../opencodex/OpenCodexInventory.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import { localOpenCodexRoutes } from "./localRoutes.ts";
import { parityVerdict } from "./parity.ts";

const INTERVAL_MS = 30 * 60 * 1000;
const decodeStatus = Schema.decodeUnknownEffect(GoatHostStatusResult);

export class HubParity extends Context.Service<
  HubParity,
  {
    readonly verify: (
      deviceAlias: string,
      scope: McpInvocationScope,
    ) => Effect.Effect<HubParityResult, OrchestratorMcpFailure>;
    readonly readLocal: Effect.Effect<OpenCodexInventorySnapshot>;
    readonly latest: (deviceAlias: string) => Effect.Effect<HubParityResult | undefined>;
  }
>()("goat/hub/HubParity") {}

const make = Effect.gen(function* () {
  const inventory = yield* Inventory.OpenCodexInventory;
  const hosts = yield* HostThreads.HostThreadsMcpService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;
  const environment = yield* HostProcess.Environment;
  const known = yield* Ref.make(new Map<string, HubParityResult>());
  const readLocal = Effect.gen(function* () {
    const snapshot = yield* inventory.readParity;
    if (!snapshot.parityEvidence) return snapshot;
    const configured = yield* settings.getSettings.pipe(Effect.option);
    if (configured._tag === "None") return snapshot;
    const wiring = localOpenCodexRoutes({
      instances: configured.value.providerInstances,
      providers: yield* providers.getProviders,
      environment,
      port: snapshot.runtime.port,
    }).map(({ status, reason }) => ({ status, reason }));
    return { ...snapshot, parityEvidence: { ...snapshot.parityEvidence, wiring } };
  }).pipe(Effect.withSpan("HubParity.readLocal"));

  const verify = Effect.fn("HubParity.verify")(function* (
    deviceAlias: string,
    scope: McpInvocationScope,
  ) {
    const home = yield* readLocal;
    const remote = yield* hosts
      .readOnHost(
        scope,
        {
          host: deviceAlias,
          tool: "goat_host_status",
          arguments: { local: true, parityEvidence: true },
          timeoutMs: 10_000,
        },
        decodeStatus,
      )
      .pipe(
        Effect.timeout("10 seconds"),
        Effect.catch((error) => {
          if (
            error._tag === "OrchestratorMcpFailure" &&
            [
              "capability_denied",
              "parent_not_active",
              "runtime_mode_escalation_denied",
              "interaction_mode_escalation_denied",
              "invalid_request",
            ].includes(error.code)
          )
            return Effect.fail(error);
          return Effect.succeed(undefined);
        }),
      );
    const entry = remote?.hosts.find(({ host }) => host === null);
    const checkedAt = yield* Clock.currentTimeMillis;
    const result = parityVerdict({
      deviceAlias,
      checkedAt,
      home,
      ...(entry?.reachability === "ok" && !entry.lastKnown && entry.metrics?.opencodex
        ? { device: entry.metrics.opencodex }
        : {}),
    });
    yield* Ref.update(known, (current) => new Map(current).set(deviceAlias, result));
    return result;
  });
  return HubParity.of({
    verify,
    readLocal,
    latest: (alias) => Ref.get(known).pipe(Effect.map((current) => current.get(alias))),
  });
});

/** Registered once on the shared Scheduler; no timer, agent turn, or repair is created. */
export const layer = Layer.effect(
  HubParity,
  Effect.gen(function* () {
    const parity = yield* make;
    const scheduler = yield* Scheduler.Scheduler;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const environmentId = yield* environment.getEnvironmentId;
    const nextAt = yield* Ref.make(0);
    yield* scheduler.register(
      "hub-parity",
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (now < (yield* Ref.get(nextAt))) return;
        yield* Ref.set(nextAt, now + INTERVAL_MS);
        const home = yield* parity.readLocal;
        if (!home.runtime.healthy || home.link.role !== "home") return;
        const scope: McpInvocationScope = {
          environmentId,
          capabilities: new Set(["orchestration"]),
          issuedAt: now,
          requestNamespace: "hub-parity",
          thread: undefined,
          client: { sessionId: "hub-parity", label: "GOAT hub parity", access: "read-only" },
        };
        yield* Effect.forEach(
          home.link.links,
          ({ alias }) => parity.verify(alias, scope).pipe(Effect.ignore),
          { concurrency: 1, discard: true },
        );
      }),
    );
    return parity;
  }),
);
