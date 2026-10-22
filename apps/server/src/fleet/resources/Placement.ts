/**
 * Where goal work runs: filter (host, model) candidates against fleet limits and quota, score
 * the survivors with choosePlacement, and keep the last decisions for goat_scheduler_status.
 *
 * @module Placement
 */
import type {
  FleetSettings,
  GoatHostStatusResult,
  HostStatusEntry,
  ModelSelection,
  PlacementDecision,
  ProjectId,
  SchedulerStatus,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as HostStatusMcpService from "../../mcp/HostStatusMcpService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as Fallback from "./Fallback.ts";
import { stepKey, toSelection } from "./fallbackPolicy.ts";
import {
  fleetThreads,
  hubTakesNoGoals,
  place,
  schedulerHostStatus,
  type HostSelector,
  type PlacementResult,
} from "./placementRules.ts";

const MAX_DECISIONS = 50;

export interface PlacementRequest {
  /** "goal:<id>" or "thread:<id>". */
  readonly owner: string;
  readonly modelSelection: ModelSelection;
  readonly fallbackChain: string | null;
  readonly hostSelector: HostSelector;
  readonly project: {
    readonly host: string | null;
    readonly projectId: ProjectId | null;
    readonly cwd: string | null;
  };
  readonly avoidHosts: ReadonlyArray<string | null>;
}

export interface PlacementShape {
  readonly place: (request: PlacementRequest) => Effect.Effect<PlacementResult>;
  readonly status: Effect.Effect<SchedulerStatus>;
  /** The same status over a host snapshot the caller read with its own authority. */
  readonly statusOf: (hosts: ReadonlyArray<HostStatusEntry>) => Effect.Effect<SchedulerStatus>;
}

export class Placement extends Context.Service<Placement, PlacementShape>()(
  "goat/fleet/resources/Placement",
) {}

/** Cordoned hosts, from the health controller (T2) when it provides this; none until then. */
export const PlacementHostConditions = Context.Reference<{
  readonly cordoned: Effect.Effect<ReadonlySet<string | null>>;
}>("goat/fleet/resources/Placement/PlacementHostConditions", {
  defaultValue: () => ({ cordoned: Effect.succeed(new Set<string | null>()) }),
});

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const hostStatus = yield* HostStatusMcpService.HostStatusMcpService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const fallback = yield* Fallback.Fallback;
  const log = yield* Ref.make<ReadonlyArray<PlacementDecision>>([]);

  const fleetSettings = settingsService.getSettings.pipe(
    Effect.map((settings) =>
      settings.hub.enabled ? hubTakesNoGoals(settings.fleet) : settings.fleet,
    ),
    Effect.orElseSucceed((): FleetSettings => ({})),
  );
  // The controller places with this machine's SSH keys, as goal launches do.
  const readHosts = Effect.gen(function* () {
    const descriptor = yield* environment.getDescriptor;
    return (yield* hostStatus
      .readForClient({
        environmentId: descriptor.environmentId,
        sessionId: "fleet-placement",
        reachHosts: true,
      })
      .pipe(Effect.orElseSucceed((): GoatHostStatusResult => ({ hosts: [] })))).hosts;
  });

  const statusOf = (hosts: ReadonlyArray<HostStatusEntry>) =>
    Effect.gen(function* () {
      const settings = yield* fleetSettings;
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const threads = fleetThreads(hosts);
      const cordoned = yield* (yield* PlacementHostConditions).cordoned;
      return {
        controllerEnabled: settings.controllerEnabled === true,
        maxRunningThreads: settings.maxRunningThreads ?? null,
        threads,
        hosts: hosts.map((entry) => schedulerHostStatus(entry, settings, cordoned, threads, now)),
        cooldowns: [...(yield* fallback.cooldowns)],
        decisions: yield* Ref.get(log),
      } satisfies SchedulerStatus;
    });

  return Placement.of({
    place: (request) =>
      Effect.gen(function* () {
        const settings = yield* fleetSettings;
        const cooling = new Set((yield* fallback.cooldowns).map(stepKey));
        // Goals that name no chain use the default one, as Fallback.next does.
        const chainId = request.fallbackChain ?? settings.defaultFallbackChain ?? null;
        const chain = chainId === null ? undefined : settings.fallbackChains?.[chainId];
        const cordoned = yield* (yield* PlacementHostConditions).cordoned;
        const seen = new Set([stepKey(request.modelSelection)]);
        const selections = [request.modelSelection];
        for (const step of chain?.steps ?? []) {
          if (seen.has(stepKey(step)) || cooling.has(stepKey(step))) continue;
          seen.add(stepKey(step));
          selections.push(toSelection(step));
        }
        const hosts = yield* readHosts;
        const now = yield* DateTime.now;
        const result = place(
          {
            owner: request.owner,
            selections,
            hostSelector: request.hostSelector,
            avoidHosts: request.avoidHosts,
            ...(request.project.projectId === null ? {} : { projectHost: request.project.host }),
            cordoned,
          },
          hosts,
          settings,
          DateTime.toEpochMillis(now),
        );
        const decision: PlacementDecision =
          result._tag === "Placed"
            ? {
                at: DateTime.formatIso(now),
                owner: request.owner,
                outcome: "placed",
                host: result.host,
                modelSelection: result.modelSelection,
                reason: result.reason ?? "only candidate",
              }
            : {
                at: DateTime.formatIso(now),
                owner: request.owner,
                outcome: "refused",
                reason:
                  result.reasons.length === 0
                    ? "no host matches"
                    : result.reasons
                        .map((item) => (item.host ?? "this machine") + ": " + item.reason.message)
                        .join(" · "),
                refusals: result.reasons,
              };
        yield* Ref.update(log, (current) => [decision, ...current].slice(0, MAX_DECISIONS));
        yield* Effect.logInfo("fleet.placement", decision);
        return result;
      }),
    status: Effect.flatMap(readHosts, statusOf),
    statusOf,
  });
});

/** Placement and Fallback share the cooldowns, so they are built together. */
export const layer = Layer.effect(Placement, make).pipe(Layer.provideMerge(Fallback.layer));
