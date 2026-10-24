import type { OpenCodexSyncMember, OpenCodexSyncReport } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { HubOcx, type HubOcxError, type OcxOutput, SYNC_EXIT } from "./HubOcx.ts";
import { OpenCodexUpdateHost } from "./OpenCodexUpdateHost.ts";
import {
  childAliases,
  childNeedsReading,
  planChild,
  planCoordinator,
  type PlannedSync,
} from "./opencodexSyncPlan.ts";

/** `ocx sync` fetches every provider's models and may relaunch Codex. */
const SYNC_TIMEOUT_MS = 5 * 60_000;
const HOME_TIMEOUT_MS = 60_000;
/** OpenCodex's notice when the Home did not answer and the last remote catalog was kept. */
const STALE = /\(stale\)/u;

/** Whether the caller may reach this Child; people and GOAT's own update may reach every one. */
export type SyncPermits = (alias: string) => Effect.Effect<boolean>;
const everyone: SyncPermits = () => Effect.succeed(true);

export class OpenCodexSync extends Context.Service<
  OpenCodexSync,
  {
    /** What a run would do now. Reads only. */
    readonly plan: (
      scope: McpInvocationScope,
      permits?: SyncPermits,
    ) => Effect.Effect<OpenCodexSyncReport>;
    /** This machine, then each Child, one at a time. */
    readonly run: (
      scope: McpInvocationScope,
      permits?: SyncPermits,
    ) => Effect.Effect<OpenCodexSyncReport>;
    readonly latest: Effect.Effect<OpenCodexSyncReport | undefined>;
    /** The latest report, then each change while a run moves through its machines. */
    readonly changes: Stream.Stream<OpenCodexSyncReport | null>;
    /** The managed update's window is open: installs, probation or a restore. Runs wait. */
    readonly markUpdating: (open: boolean) => Effect.Effect<void>;
    /** Runs `body` alone: a run in progress finishes first and none starts during it. */
    readonly exclusive: <A, E, R>(body: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    /** Opens the report an update window fills in, one member per step. */
    readonly beginUpdate: (targetVersion: string) => Effect.Effect<void>;
    /** One member right after its install, inside `exclusive`, so it never takes the permit. */
    readonly syncUpdatedMember: (
      alias: string | null,
      scope: McpInvocationScope,
    ) => Effect.Effect<void>;
  }
>()("goat/hub/OpenCodexSync") {}

const finished = (
  alias: string | null,
  restartCodex: boolean,
  output: OcxOutput,
  device: boolean,
): OpenCodexSyncMember => {
  const base = { alias, restartCodex };
  if (output.code === 0)
    return {
      ...base,
      state: "synced",
      ...(STALE.test(output.stdout) ? { reason: "stale" } : restartCodex ? {} : { reason: "busy" }),
    };
  if (device && output.code === SYNC_EXIT.notConnected)
    return { alias, state: "skipped", restartCodex: false, reason: "not-connected" };
  if (device && output.code === SYNC_EXIT.connectionChanged)
    return { ...base, state: "failed", reason: "connection-changed" };
  return {
    ...base,
    state: "failed",
    reason: output.code === 124 ? "timed-out" : `exit-${output.code}`,
  };
};

const unreachable = (
  alias: string | null,
  restartCodex: boolean,
  error: HubOcxError,
): OpenCodexSyncMember => ({
  alias,
  state: "failed",
  restartCodex,
  reason: error.reason === "ocx_missing" ? "not-installed" : "unreachable",
});

const make = Effect.gen(function* () {
  const host = yield* OpenCodexUpdateHost;
  const ocx = yield* HubOcx;
  const report = yield* SubscriptionRef.make<OpenCodexSyncReport | null>(null);
  const updating = yield* Ref.make(false);
  // One sync at a time, and none while an update window installs.
  const permit = yield* Semaphore.make(1);

  const put = (row: OpenCodexSyncMember) =>
    SubscriptionRef.update(report, (current) =>
      current === null
        ? current
        : {
            ...current,
            members: current.members.some(({ alias }) => alias === row.alias)
              ? current.members.map((member) => (member.alias === row.alias ? row : member))
              : [...current.members, row],
          },
    );

  const readPlan = Effect.fn("OpenCodexSync.readPlan")(function* (
    scope: McpInvocationScope,
    permits: SyncPermits,
  ) {
    const coordinator = yield* host.member(null, scope);
    const home = coordinator.snapshot;
    const children = yield* Effect.forEach(
      childAliases(home),
      (alias) =>
        Effect.gen(function* () {
          // A Child the caller may not reach is never read either.
          if (!(yield* permits(alias))) return planChild(home, alias, undefined, false);
          const member = childNeedsReading(home, alias)
            ? yield* host.member(alias, scope)
            : undefined;
          return planChild(home, alias, member, true);
        }),
      { concurrency: 4 },
    );
    return [planCoordinator(coordinator), ...children];
  });

  /** Every member of this machine's window, skipped while the managed update owns them. */
  const updatingRows = Effect.fn("OpenCodexSync.updatingRows")(function* (
    scope: McpInvocationScope,
  ) {
    const home = (yield* host.member(null, scope)).snapshot;
    return [null, ...childAliases(home)].map((alias): OpenCodexSyncMember => ({
      alias,
      state: "skipped",
      restartCodex: false,
      reason: "updating",
    }));
  });

  /** This machine. New turns wait while Codex restarts, and the count is read again once they do. */
  const syncHere = Effect.fn("OpenCodexSync.syncHere")(function* (scope: McpInvocationScope) {
    const planned = planCoordinator(yield* host.member(null, scope)).member;
    if (planned.state !== "ready") return planned;
    const held = planned.restartCodex && (yield* host.holdAdmission(null));
    return yield* Effect.gen(function* () {
      const restartCodex = held && (yield* host.member(null, scope)).runningTurns === 0;
      return yield* ocx
        .home(["sync", ...(restartCodex ? ["--restart-codex"] : [])], SYNC_TIMEOUT_MS)
        .pipe(
          Effect.map((output) => finished(null, restartCodex, output, false)),
          Effect.catch((error) => Effect.succeed(unreachable(null, restartCodex, error))),
        );
    }).pipe(Effect.ensuring(held ? host.releaseAdmission(null) : Effect.void));
  });

  /** One Child, judged again from fresh readings right before it runs. */
  const syncChild = Effect.fn("OpenCodexSync.syncChild")(function* (
    alias: string,
    scope: McpInvocationScope,
    permits: SyncPermits,
  ) {
    if (!(yield* permits(alias))) return planChild(undefined, alias, undefined, false).member;
    const fresh = Effect.gen(function* () {
      const home = (yield* host.member(null, scope)).snapshot;
      return planChild(home, alias, yield* host.member(alias, scope), true);
    });
    let planned: PlannedSync = yield* fresh;
    if (planned.member.reason === "reconnect" && planned.linkId !== undefined) {
      // The Child still reports this Home's link; only the tunnel is down.
      yield* ocx
        .home(["link", "reconnect", "--link-id", planned.linkId, "--json"], HOME_TIMEOUT_MS)
        .pipe(Effect.ignore);
      planned = yield* fresh;
      if (planned.member.reason === "reconnect")
        return { alias, state: "skipped", restartCodex: false, reason: "not-connected" } as const;
    }
    if (planned.member.state !== "ready" || planned.linkId === undefined) return planned.member;
    return yield* ocx
      .syncDevice(alias, { linkId: planned.linkId, restartCodex: true }, SYNC_TIMEOUT_MS)
      .pipe(
        Effect.map((output) => finished(alias, true, output, true)),
        Effect.catch((error) => Effect.succeed(unreachable(alias, true, error))),
      );
  });

  const syncOne = (alias: string | null, scope: McpInvocationScope, permits: SyncPermits) =>
    alias === null ? syncHere(scope) : syncChild(alias, scope, permits);

  const plan = Effect.fn("OpenCodexSync.plan")(function* (
    scope: McpInvocationScope,
    permits: SyncPermits = everyone,
  ) {
    const checkedAt = yield* Clock.currentTimeMillis;
    const members = (yield* Ref.get(updating))
      ? yield* updatingRows(scope)
      : (yield* readPlan(scope, permits)).map(({ member }) => member);
    return { trigger: "plan", checkedAt, members } satisfies OpenCodexSyncReport;
  });

  const run = (scope: McpInvocationScope, permits: SyncPermits = everyone) =>
    permit.withPermit(
      Effect.gen(function* () {
        const checkedAt = yield* Clock.currentTimeMillis;
        let current: OpenCodexSyncReport = { trigger: "manual", checkedAt, members: [] };
        const publish = (members: ReadonlyArray<OpenCodexSyncMember>) => {
          current = { ...current, members };
          return SubscriptionRef.set(report, current);
        };
        if (yield* Ref.get(updating)) {
          yield* publish(yield* updatingRows(scope));
          return current;
        }
        yield* publish((yield* readPlan(scope, permits)).map(({ member }) => member));
        for (const member of current.members) {
          if (member.state !== "ready") continue;
          const replace = (row: OpenCodexSyncMember) =>
            publish(current.members.map((entry) => (entry.alias === row.alias ? row : entry)));
          yield* replace({ ...member, state: "syncing" });
          const done = yield* syncOne(member.alias, scope, permits);
          yield* replace({ ...done, at: yield* Clock.currentTimeMillis });
        }
        return current;
      }).pipe(Effect.withSpan("OpenCodexSync.run")),
    );

  return OpenCodexSync.of({
    plan,
    run,
    latest: SubscriptionRef.get(report).pipe(Effect.map((value) => value ?? undefined)),
    changes: SubscriptionRef.changes(report),
    markUpdating: (open) => Ref.set(updating, open),
    exclusive: (body) => permit.withPermit(body),
    beginUpdate: (targetVersion) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((checkedAt) =>
          SubscriptionRef.set(report, { trigger: "update", checkedAt, targetVersion, members: [] }),
        ),
      ),
    syncUpdatedMember: Effect.fn("OpenCodexSync.syncUpdatedMember")(function* (alias, scope) {
      yield* put({ alias, state: "syncing", restartCodex: true });
      const done = yield* syncOne(alias, scope, everyone);
      yield* put({ ...done, at: yield* Clock.currentTimeMillis });
    }),
  });
});

export const layer = Layer.effect(OpenCodexSync, make);
