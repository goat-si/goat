import {
  type GoatclawFleetPolicy,
  type GoatclawHostSync,
  type GoatclawSettings,
  GoatGoatclawSyncResult,
  goatclawPolicyContent,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as Scheduler from "../scheduling/Scheduler.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";

/**
 * goatclaw is on or off for the whole fleet (ADR-0021): turning it on or off on any machine
 * applies to every host connected to it. Each machine exchanges its policy with the hosts it
 * reaches, and every machine keeps the most recently changed one, so a change spreads both ways
 * and through hosts that are themselves connected onward. A policy nobody ever set carries no
 * stamp and never wins.
 */
export const SYNC_TOOL = agentSurfaceRegistry["permission_profile.sync"].name;
/** A host that holds the policy is asked again this often, to notice a change made there. */
export const REFRESH_MS = 10 * 60_000;
/** A host that did not answer is retried this often. */
export const RETRY_MS = 60_000;
const CALL_TIMEOUT_MS = 15_000;

const policyOf = (settings: GoatclawSettings): GoatclawFleetPolicy => ({
  enabled: settings.enabled,
  defaultProfile: settings.defaultProfile,
  profiles: settings.profiles,
  ...(settings.updatedAt === undefined ? {} : { updatedAt: settings.updatedAt }),
});
const versionOf = (policy: GoatclawFleetPolicy) =>
  `${policy.updatedAt ?? ""}\u0000${goatclawPolicyContent(policy)}`;

/** Whether `incoming` replaces `current`: a deliberately set policy, no older, that changes something. */
export const supersedes = (incoming: GoatclawFleetPolicy, current: GoatclawFleetPolicy) =>
  incoming.updatedAt !== undefined &&
  (current.updatedAt === undefined || incoming.updatedAt >= current.updatedAt) &&
  versionOf(incoming) !== versionOf(current);

const decodeResult = Schema.decodeUnknownEffect(GoatGoatclawSyncResult);
const isMcpFailure = Schema.is(OrchestratorMcpFailure);
const pending = (message?: string): GoatclawHostSync =>
  message === undefined ? { state: "pending" } : { state: "pending", message };

export class GoatclawFleetSync extends Context.Service<
  GoatclawFleetSync,
  {
    /** The receiving side of `goat_goatclaw_sync`: keeps the newer policy and returns its own. */
    readonly receive: (
      policy: GoatclawFleetPolicy,
    ) => Effect.Effect<GoatclawFleetPolicy, OrchestratorMcpFailure>;
    /**
     * Brings one host up to date now unless it already holds this machine's policy.
     * `enforcesCeilings` is true once that host's GOAT answered the exchange, which proves it
     * enforces a forwarded permission ceiling on launches and follow-up sends.
     */
    readonly ensure: (host: string) => Effect.Effect<HostReach>;
    /** Syncs every connected host that is due. The scheduler runs it. */
    readonly reconcile: Effect.Effect<void>;
    readonly hostState: (host: string) => Effect.Effect<GoatclawHostSync>;
  }
>()("goat/goatclaw/FleetSync/GoatclawFleetSync") {}

export interface HostReach {
  readonly sync: GoatclawHostSync;
  readonly enforcesCeilings: boolean;
}

interface HostRecord extends HostReach {
  /** The local policy this host was last synced against. */
  readonly version: string;
  readonly checkedAt: number;
  readonly sync: GoatclawHostSync;
}

export const make = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
  const records = new Map<string, HostRecord>();
  const gates = new Map<string, Semaphore.Semaphore>();
  const gate = (host: string) => {
    const existing = gates.get(host);
    if (existing !== undefined) return existing;
    const created = Semaphore.makeUnsafe(1);
    gates.set(host, created);
    return created;
  };
  const unavailable = () =>
    new OrchestratorMcpFailure({
      code: "orchestration_error",
      message: "goatclaw settings are unavailable on this machine.",
    });
  const read = settings.getSettings.pipe(
    Effect.map((value) => policyOf(value.goatclaw)),
    Effect.mapError(unavailable),
  );

  const receive = Effect.fn("GoatclawFleetSync.receive")(function* (incoming: GoatclawFleetPolicy) {
    if (!supersedes(incoming, yield* read)) return yield* read;
    const updated = yield* settings
      .updateSettingsWith((current) =>
        Effect.succeed(
          supersedes(incoming, policyOf(current.goatclaw))
            ? {
                goatclaw: {
                  enabled: incoming.enabled,
                  defaultProfile: incoming.defaultProfile,
                  profiles: incoming.profiles,
                  ...(incoming.updatedAt === undefined ? {} : { updatedAt: incoming.updatedAt }),
                },
              }
            : {},
        ),
      )
      .pipe(Effect.mapError(unavailable));
    return policyOf(updated.goatclaw);
  });

  /**
   * goatclaw switched on before fleet sync existed was still a person's choice, so it becomes the
   * fleet's policy the first time this machine syncs. A policy left at its default stays unstamped.
   */
  const local = Effect.gen(function* () {
    const current = yield* read;
    if (!current.enabled || current.updatedAt !== undefined) return current;
    const now = DateTime.formatIso(yield* DateTime.now);
    const updated = yield* settings
      .updateSettingsWith((value) =>
        Effect.succeed(
          value.goatclaw.enabled && value.goatclaw.updatedAt === undefined
            ? { goatclaw: { updatedAt: now } }
            : {},
        ),
      )
      .pipe(Effect.mapError(unavailable));
    return policyOf(updated.goatclaw);
  });

  const classify = (host: string, error: unknown): HostReach => {
    if (error instanceof SshRemoteDispatch.SshRemoteDispatchError) {
      if (
        error.reason === "remote_refused" &&
        error.message.startsWith(`GOAT on ${host} does not have ${SYNC_TOOL}`)
      )
        return { sync: { state: "outdated", message: error.message }, enforcesCeilings: false };
      // The tool itself refused (a linked host's token lacks settings:write, say): that GOAT is
      // new enough to enforce a ceiling, though the policy has not reached it.
      return {
        sync: pending(error.message),
        enforcesCeilings: error.reason === "remote_refused" && error.remoteCode !== undefined,
      };
    }
    return {
      sync: pending(isMcpFailure(error) ? error.message : `${host} answered unexpectedly.`),
      enforcesCeilings: false,
    };
  };

  /**
   * `connect` is for a launch or send that is about to reach the host anyway: it uses the same
   * connection it will, so a compatible runtime of another build still answers. The background
   * reconcile never starts or wakes a runtime.
   */
  const syncHost = Effect.fn("GoatclawFleetSync.syncHost")(function* (
    host: string,
    connect = false,
  ) {
    const checkedAt = yield* Clock.currentTimeMillis;
    const outcome = yield* local.pipe(
      Effect.flatMap((mine) =>
        dispatch
          .callHostTool(
            {
              host,
              tool: SYNC_TOOL,
              arguments: { policy: mine },
              // Starts no thread there; the remote session only needs to change settings.
              writes: true,
              settingsWrite: true,
              ...(connect ? {} : { requireReady: true as const }),
              timeoutMs: CALL_TIMEOUT_MS,
            },
            Effect.succeed("approval-required" as const),
          )
          .pipe(
            Effect.flatMap(decodeResult),
            Effect.flatMap(({ policy: theirs }) =>
              receive(theirs).pipe(
                Effect.map((adopted) => ({
                  version: versionOf(adopted),
                  enforcesCeilings: true,
                  sync:
                    goatclawPolicyContent(adopted) === goatclawPolicyContent(theirs)
                      ? ({ state: "applied" } satisfies GoatclawHostSync)
                      : pending(`${host} kept a different goatclaw policy.`),
                })),
              ),
            ),
            Effect.catch((error) =>
              Effect.succeed({ version: versionOf(mine), ...classify(host, error) }),
            ),
          ),
      ),
      Effect.catch((error) => Effect.succeed({ version: "", ...classify(host, error) })),
    );
    records.set(host, { ...outcome, checkedAt });
    if (outcome.sync.state !== "applied")
      yield* Effect.logInfo("goatclaw.fleetSync.notApplied", {
        host,
        state: outcome.sync.state,
        message: outcome.sync.message,
      });
    return { sync: outcome.sync, enforcesCeilings: outcome.enforcesCeilings };
  });

  const ensure = (host: string) =>
    gate(host).withPermits(1)(
      Effect.gen(function* () {
        const record = records.get(host);
        const mine = yield* read.pipe(Effect.option);
        if (
          record !== undefined &&
          record.sync.state === "applied" &&
          Option.isSome(mine) &&
          record.version === versionOf(mine.value)
        )
          return { sync: record.sync, enforcesCeilings: record.enforcesCeilings };
        return yield* syncHost(host, true);
      }),
    );

  const due = (host: string, version: string, now: number) => {
    const record = records.get(host);
    if (record === undefined || record.version !== version) return true;
    const age = now - record.checkedAt;
    return age >= (record.sync.state === "pending" ? RETRY_MS : REFRESH_MS);
  };

  const reconcile = Effect.gen(function* () {
    const hosts = yield* dispatch.connectedHosts;
    if (hosts.length === 0) return;
    const mine = yield* local.pipe(Effect.option);
    const version = Option.isSome(mine) ? versionOf(mine.value) : "";
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.forEach(
      hosts.filter((host) => due(host, version, now)),
      (host) => gate(host).withPermits(1)(syncHost(host)),
      { concurrency: 4, discard: true },
    );
  }).pipe(Effect.withSpan("GoatclawFleetSync.reconcile"));

  const hostState = (host: string) => Effect.sync(() => records.get(host)?.sync ?? pending());

  return GoatclawFleetSync.of({ receive, ensure, reconcile, hostState });
});

/** Registered once on the shared Scheduler, which ticks every few seconds; `due` throttles. */
export const layer = Layer.effect(
  GoatclawFleetSync,
  Effect.gen(function* () {
    const service = yield* make;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("goatclaw-fleet-sync", service.reconcile);
    return service;
  }),
);
