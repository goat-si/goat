/**
 * Hub-down policy for goal work on this machine (design 261021_goatclaw_hub §1.6). The goal
 * controller asks before each action that would start provider work: unaffected, a hop to this
 * device's own sign-in, or paused. While work is paused one decision item asks the supervisor to
 * wait or move it; the item is withdrawn when the hub answers again. Nothing here switches the hub
 * or changes OpenCodex settings.
 *
 * @module HubDown
 */
import {
  FLEET_LOCAL_HOST_KEY,
  CommandId,
  type DecisionOption,
  type ModelSelection,
  type OpenCodexInventorySnapshot,
  type ProviderInstanceId,
  type ThreadId,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import { homeLocalFallback } from "@goat/shared/opencodexCompat";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import { HostHealthMonitor } from "../fleet/health/HostHealthMonitor.ts";
import * as DecisionInbox from "../goatclaw/DecisionInbox.ts";
import * as Inventory from "../opencodex/OpenCodexInventory.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { decideHubWork, homeUnreachable, type HubWork, UNAFFECTED } from "./hubDownPolicy.ts";
import { localOpenCodexRoutes } from "./localRoutes.ts";

/** A relayed request per minute at most; a Child waits up to 15 s for its tunnel per request. */
const OBSERVE_INTERVAL_MS = 60_000;
const HUB_DOWN_DECISION_PREFIX = "decision:hub-unreachable:";
const MAX_MOVE_OPTIONS = 5;

export interface PausedGoalWork {
  readonly goalId: string;
  readonly title: string;
  readonly ownerThreadId: ThreadId | null;
  readonly instanceId: ProviderInstanceId;
  readonly message: string;
}

export interface HubDownShape {
  /** What new goal work with this selection on this machine does now. */
  readonly forWork: (selection: ModelSelection) => Effect.Effect<HubWork>;
  /** Records a hop's notice on the thread it moved; the key makes a repeat a no-op. */
  readonly notice: (threadId: ThreadId, key: string, message: string) => Effect.Effect<void>;
  /** After a controller tick: opens the one decision while work is paused, withdraws it after. */
  readonly settle: (paused: ReadonlyArray<PausedGoalWork>) => Effect.Effect<void>;
}

/** Unaffected until the server provides the live policy, so other compositions keep today's behavior. */
export const HubDown = Context.Reference<HubDownShape>("goat/hub/HubDown", {
  defaultValue: () => ({
    forWork: () => Effect.succeed(UNAFFECTED),
    notice: () => Effect.void,
    settle: () => Effect.void,
  }),
});

interface Observation {
  readonly observedAt: number | null;
  readonly unreachable: boolean;
  readonly snapshot: OpenCodexInventorySnapshot | null;
  /** OpenCodex's permission as the Home last stated it; kept through an outage. */
  readonly permission: boolean | undefined;
}

const isLinked = (snapshot: OpenCodexInventorySnapshot) =>
  snapshot.link.role === "child" || snapshot.hubClient !== undefined;

const make = Effect.gen(function* () {
  const inventory = yield* Inventory.OpenCodexInventory;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;
  const inbox = yield* DecisionInbox.DecisionInbox;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const monitor = yield* Effect.serviceOption(HostHealthMonitor);
  const environment = yield* HostProcess.Environment;
  const hostname = yield* HostProcess.Hostname;
  const state = yield* Ref.make<Observation>({
    observedAt: null,
    unreachable: false,
    snapshot: null,
    permission: undefined,
  });
  const permit = yield* Semaphore.make(1);

  const observe = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const current = yield* Ref.get(state);
    if (current.observedAt !== null && now - current.observedAt < OBSERVE_INTERVAL_MS)
      return current;
    const quick = yield* inventory.read;
    // Only a linked device makes the relayed request; a standalone one never needs a Home.
    const snapshot = isLinked(quick) ? yield* inventory.readParity : quick;
    const unreachable = homeUnreachable(snapshot);
    const next: Observation = {
      observedAt: now,
      unreachable,
      snapshot,
      permission: unreachable ? current.permission : homeLocalFallback(snapshot),
    };
    if (unreachable !== current.unreachable)
      yield* Effect.logInfo("hub.down.observed", { unreachable });
    yield* Ref.set(state, next);
    return next;
  }).pipe(permit.withPermits(1), Effect.withSpan("HubDown.observe"));

  const forWork: HubDownShape["forWork"] = Effect.fn("HubDown.forWork")(function* (selection) {
    const observed = yield* observe;
    if (!observed.unreachable || observed.snapshot === null) return UNAFFECTED;
    const configured = yield* settings.getSettings.pipe(Effect.option);
    if (configured._tag === "None")
      return {
        _tag: "Paused",
        message: "The hub is unreachable and server settings could not be read.",
      } satisfies HubWork;
    const snapshots = yield* providers.getProviders;
    return decideHubWork({
      unreachable: true,
      selection,
      routes: localOpenCodexRoutes({
        instances: configured.value.providerInstances,
        providers: snapshots,
        environment,
        port: observed.snapshot.runtime.port,
      }),
      providers: snapshots,
      goatAllows: configured.value.hub.devices[FLEET_LOCAL_HOST_KEY]?.localFallback === true,
      openCodexAllows: observed.permission,
    });
  });

  const notice: HubDownShape["notice"] = (threadId, key, message) =>
    threads
      .dispatch({
        type: "thread.notice.record",
        commandId: CommandId.make("hub-down-notice:" + key),
        threadId,
        recordKey: "hub-down:" + key,
        message,
      })
      .pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning("hub.down.notice-failed", { threadId, cause }),
        ),
      );

  /** Hosts that answered, whose models do not depend on a Home, with a paused provider kind. */
  const moveTargets = Effect.fn("HubDown.moveTargets")(function* (
    paused: ReadonlyArray<PausedGoalWork>,
  ) {
    if (monitor._tag === "None") return [];
    const snapshots = yield* providers.getProviders;
    const drivers = new Set(
      paused.flatMap(
        ({ instanceId }) =>
          snapshots.find((provider) => provider.instanceId === instanceId)?.driver ?? [],
      ),
    );
    const known = yield* monitor.value.known;
    return known
      .filter(({ sample }) => {
        const metrics = sample?.reachability === "ok" ? sample.metrics : undefined;
        if (metrics === undefined) return false;
        const opencodex = metrics.opencodex;
        if (opencodex !== undefined && (opencodex.link.role !== "none" || opencodex.hubClient))
          return false;
        return (metrics.providers ?? metrics.quotas).some(
          (provider) =>
            drivers.has(provider.driver) && ("enabled" in provider ? provider.enabled : true),
        );
      })
      .map(({ host }) => host)
      .toSorted()
      .slice(0, MAX_MOVE_OPTIONS);
  });

  const settle: HubDownShape["settle"] = Effect.fn("HubDown.settle")(
    function* (paused) {
      const current = yield* Ref.get(state);
      // Observe once after a start, so an item left open across a restart is withdrawn.
      const observed =
        current.observedAt === null || paused.length > 0 || current.unreachable
          ? yield* observe
          : current;
      if (!observed.unreachable) {
        const withdrawn = yield* inbox.withdrawOpen(HUB_DOWN_DECISION_PREFIX);
        if (withdrawn > 0) yield* Effect.logInfo("hub.down.decision-withdrawn", { withdrawn });
        return;
      }
      if (paused.length === 0) return;
      const ordered = paused.toSorted((left, right) => left.goalId.localeCompare(right.goalId));
      const goals = [...new Map(ordered.map((work) => [work.goalId, work])).values()];
      const hosts = yield* moveTargets(goals);
      const options: Array<typeof DecisionOption.Type> = [
        {
          id: "wait",
          label: "Wait for the hub",
          consequence:
            "Goal work here stays paused and resumes by itself when the hub answers; this item is then withdrawn.",
        },
        ...hosts.map((host) => ({
          id: "move:" + host,
          label: "Move the work to " + host,
          consequence:
            host +
            " has its own sign-in. The goal's owner thread is told to move the work there; GOAT moves nothing by itself.",
        })),
      ];
      const raised = yield* inbox.raiseOnce({
        idPrefix: HUB_DOWN_DECISION_PREFIX,
        fromThreadId:
          goals.find(({ ownerThreadId }) => ownerThreadId !== null)?.ownerThreadId ?? null,
        request: {
          title: "Hub unreachable: goal work on " + hostname + " is paused",
          context:
            goals[0]!.message +
            " Paused goals: " +
            goals.map(({ title, goalId }) => title + " (" + goalId + ")").join(", ") +
            ". Running turns continue, and GOAT never switches the hub on its own.",
          options,
          recommended: "wait",
          requiredProfile: "manager",
        },
      });
      if (raised !== undefined)
        yield* Effect.logInfo("hub.down.decision-raised", { decisionId: raised.id });
    },
    Effect.catch((error) => Effect.logWarning("hub.down.settle-failed", { error })),
  );

  return { forWork, notice, settle } satisfies HubDownShape;
});

export const layer = Layer.effect(HubDown, make);
