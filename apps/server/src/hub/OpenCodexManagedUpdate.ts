import {
  type HubParityResult,
  OpenCodexUpdateMemberRecord,
  type OpenCodexUpdateStatus,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { isRolloutEligible, rolloutBucket } from "../cloud/autoUpdatePolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as HubParity from "./HubParity.ts";
import { OpenCodexSync } from "./OpenCodexSync.ts";
import { type OpenCodexRelease, OpenCodexUpdateHost } from "./OpenCodexUpdateHost.ts";
import {
  failedTargetKey,
  type OpenCodexUpdateMember,
  type OpenCodexUpdateStep,
  planOpenCodexUpdate,
} from "./opencodexUpdatePlan.ts";

const MINUTE = 60_000;
const CHECK_INTERVAL_MS = 6 * 60 * MINUTE;
const RETRY_INTERVAL_MS = 10 * MINUTE;
const PROBATION_MS = 10 * MINUTE;
/** Probation watches the moved members this often, so a crash in the middle is not missed. */
const PROBATION_CHECK_MS = MINUTE;
/** `/healthz` uptime is whole seconds and the read takes time; a real restart moves further. */
const RESTART_TOLERANCE_MS = 2_000;
/** Rollback reasons naming one member whose runtime already fails its turns. */
const HEALTH_FAILURES = new Set(["health-failed", "probation-health-failed"]);
const STATE_FILE = "opencodex-update.json";

const State = Schema.Struct({
  members: Schema.Array(OpenCodexUpdateMemberRecord),
  failedTargets: Schema.Record(Schema.String, Schema.String),
  /** The open window survives a GOAT restart: its steps, baseline, roles and process starts. */
  window: Schema.optional(
    Schema.Struct({
      targetVersion: Schema.String,
      /** Every Child linked when the window opened; recovery judges parity against all of them. */
      children: Schema.Array(Schema.String),
      steps: Schema.Array(
        Schema.Struct({
          alias: Schema.NullOr(Schema.String),
          fromVersion: Schema.String,
          restored: Schema.optional(Schema.Boolean),
        }),
      ),
      probationEndsAt: Schema.optional(Schema.Number),
      baseline: Schema.Record(
        Schema.String,
        Schema.Literals(["ok", "degraded", "broken", "unproven"]),
      ),
      roles: Schema.Record(Schema.String, Schema.String),
      startedAt: Schema.Record(Schema.String, Schema.Number),
      processIds: Schema.Record(Schema.String, Schema.Int),
      /** Set once a rollback starts; a restore that failed is resumed before anything else. */
      restoring: Schema.optional(Schema.String),
      /** The member that failed its own health check; only it is restored without waiting. */
      failedMember: Schema.optional(Schema.String),
    }),
  ),
});
type State = typeof State.Type;
const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(State));
const encodeState = Schema.encodeSync(Schema.fromJsonString(State));

export class OpenCodexManagedUpdate extends Context.Service<
  OpenCodexManagedUpdate,
  {
    readonly status: Effect.Effect<OpenCodexUpdateStatus | undefined>;
    /** The scheduler's due work: one plan and, when eligible, one window. */
    readonly check: Effect.Effect<void>;
    /**
     * A person asked from the update dialog: the same check without waiting out the retry timer.
     * The staged rollout, idle wait and probation still apply.
     */
    readonly checkNow: Effect.Effect<OpenCodexUpdateStatus | undefined>;
  }
>()("goat/hub/OpenCodexManagedUpdate") {}

const brokeAgainst = (
  baseline: Readonly<Record<string, HubParityResult["verdict"]>>,
  alias: string,
  result: HubParityResult,
) => result.verdict === "broken" && baseline[alias] !== "broken";

type Window = NonNullable<State["window"]>;

const make = Effect.gen(function* () {
  const host = yield* OpenCodexUpdateHost;
  const sync = yield* OpenCodexSync;
  const parity = yield* HubParity.HubParity;
  const settings = yield* ServerSettings.ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const environmentId = yield* environment.getEnvironmentId;
  const stateFile = path.join(config.stateDir, STATE_FILE);
  const status = yield* Ref.make<OpenCodexUpdateStatus | undefined>(undefined);
  const nextAt = yield* Ref.make(0);
  const release = yield* Ref.make<{ at: number; value: OpenCodexRelease | undefined } | undefined>(
    undefined,
  );
  const state = yield* Ref.make<State>({ members: [], failedTargets: {} });
  // A person's check and the scheduler's must never open two windows at once.
  const checking = yield* Semaphore.make(1);

  /** A file that exists but cannot be read must not erase the memory of a rolled-back target. */
  const readState = Effect.gen(function* () {
    if (!(yield* fs.exists(stateFile))) return { members: [], failedTargets: {} } satisfies State;
    return Option.getOrUndefined(decodeState(yield* fs.readFileString(stateFile)));
  }).pipe(Effect.orElseSucceed(() => undefined));
  // A window restored after a GOAT restart holds manual syncs off before the first check, which
  // the hub and goatclaw settings may never run.
  yield* readState.pipe(
    Effect.flatMap((stored) => sync.markUpdating(stored?.window !== undefined)),
  );
  /** Every change is one atomic write, so a GOAT restart sees either all of it or none. */
  const mutate = Effect.fn("OpenCodexManagedUpdate.mutate")(function* (
    change: (current: State, at: number) => State,
  ) {
    const next = change(yield* Ref.get(state), yield* Clock.currentTimeMillis);
    yield* Ref.set(state, next);
    yield* sync.markUpdating(next.window !== undefined);
    yield* fs.makeDirectory(config.stateDir, { recursive: true });
    const temporary = `${stateFile}.tmp`;
    yield* fs.writeFileString(temporary, encodeState(next));
    yield* fs.rename(temporary, stateFile);
  });
  const withRecords = (
    current: State,
    at: number,
    steps: ReadonlyArray<OpenCodexUpdateStep>,
    targetVersion: string,
    phase: OpenCodexUpdateMemberRecord["phase"],
    reason?: string,
  ): State => {
    const aliases = new Set(steps.map(({ alias }) => alias));
    return {
      ...current,
      members: [
        ...current.members.filter(({ alias }) => !aliases.has(alias)),
        ...steps.map((step) => ({
          alias: step.alias,
          phase,
          fromVersion: step.fromVersion,
          targetVersion,
          at,
          ...(reason === undefined ? {} : { reason }),
        })),
      ],
    };
  };
  const withWindow = (current: State, change: (window: Window) => Window | undefined): State => {
    const { window, ...rest } = current;
    const next = window === undefined ? undefined : change(window);
    return next === undefined ? rest : { ...rest, window: next };
  };
  const record = (
    step: OpenCodexUpdateStep,
    targetVersion: string,
    phase: OpenCodexUpdateMemberRecord["phase"],
    reason?: string,
  ) => mutate((current, at) => withRecords(current, at, [step], targetVersion, phase, reason));
  const phaseOf = (current: State, alias: string | null, targetVersion: string) =>
    current.members.find((entry) => entry.alias === alias && entry.targetVersion === targetVersion)
      ?.phase;
  /** Restarting the Home cuts every Child's routing, so a Home step affects all of them. */
  const affectedBy = (
    steps: ReadonlyArray<{ readonly alias: string | null }>,
    children: ReadonlyArray<string>,
  ): ReadonlyArray<string | null> =>
    steps.some(({ alias }) => alias === null)
      ? [null, ...children]
      : steps.map(({ alias }) => alias);
  /** Runs `body` while every affected member refuses new turns, or not at all. */
  const holding = <A, E>(affected: ReadonlyArray<string | null>, body: Effect.Effect<A, E>) => {
    const held: Array<string | null> = [];
    return Effect.gen(function* () {
      for (const alias of affected) {
        if (!(yield* host.holdAdmission(alias))) return "admission-unsupported" as const;
        held.push(alias);
      }
      return yield* body;
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          Effect.forEach(held, (alias) => host.releaseAdmission(alias), { discard: true }),
        ),
      ),
    );
  };

  /**
   * Children first, then the Home, so a Child is never left ahead of the Home it relays to. A
   * restore that cannot be proven stops here and keeps the window open; the next check resumes
   * it before anything else moves.
   */
  const rollBack = Effect.fn("OpenCodexManagedUpdate.rollBack")(function* (
    reason: string,
    remember: boolean,
    scope: McpInvocationScope,
    failedAlias?: string | null,
  ) {
    const opened = (yield* Ref.get(state)).window;
    if (opened === undefined) return true;
    if (opened.restoring === undefined)
      yield* mutate((current) =>
        withWindow(
          {
            ...current,
            failedTargets: remember
              ? {
                  ...current.failedTargets,
                  ...Object.fromEntries(
                    opened.steps.map(({ alias }) => [failedTargetKey(alias), opened.targetVersion]),
                  ),
                }
              : current.failedTargets,
          },
          (window) => ({
            ...window,
            restoring: reason,
            ...(HEALTH_FAILURES.has(reason) && failedAlias !== undefined
              ? { failedMember: failedTargetKey(failedAlias) }
              : {}),
          }),
        ),
      );
    const window = (yield* Ref.get(state)).window!;
    const restore = Effect.gen(function* () {
      for (const step of window.steps.toReversed()) {
        if (step.restored === true) continue;
        // Only the member being restored, when it is the one that failed its health check, may
        // restart under work: it already fails its turns. Everyone else this restart touches,
        // including a Child restored earlier, waits for idle like the update itself.
        const touched = (step.alias === null ? [null, ...window.children] : [step.alias]).filter(
          (alias) => !(alias === step.alias && failedTargetKey(alias) === window.failedMember),
        );
        const members = yield* Effect.forEach(touched, (alias) => host.member(alias, scope));
        if (members.some(({ runningTurns }) => runningTurns !== 0)) return false;
        const installed = yield* host.install(step.alias, step.fromVersion);
        const snapshot = installed ? (yield* host.member(step.alias, scope)).snapshot : undefined;
        if (
          snapshot?.runtime.healthy !== true ||
          snapshot.runtime.version !== step.fromVersion ||
          snapshot.runtime.role !== window.roles[failedTargetKey(step.alias)] ||
          snapshot.parityEvidence?.modelsStatus !== 200
        ) {
          yield* record(step, window.targetVersion, "rollback-failed", window.restoring);
          yield* Effect.logWarning("opencodex.update.rollback-failed", {
            alias: step.alias,
            targetVersion: window.targetVersion,
          });
          return false;
        }
        yield* mutate((current, at) =>
          withWindow(
            withRecords(current, at, [step], window.targetVersion, "rolled-back", window.restoring),
            (open) => ({
              ...open,
              steps: open.steps.map((entry) =>
                entry.alias === step.alias ? { ...entry, restored: true } : entry,
              ),
            }),
          ),
        );
      }
      // Restored versions are not enough: the pair must route again before the window closes.
      if (!(yield* paritySurvives(window.children, scope))) return false;
      yield* mutate((current) => withWindow(current, () => undefined));
      yield* Effect.logWarning("opencodex.update.rolled-back", {
        targetVersion: window.targetVersion,
        reason: window.restoring,
      });
      return true;
    });
    return (yield* holding(affectedBy(window.steps, window.children), restore)) === true;
  });

  /**
   * Health after restart: the target version, the same role, P3 on its own port, and the same
   * process that passed the first check. A new process id or a moved start time means the
   * runtime crashed and was restarted; a member whose `/healthz` reports neither never passes.
   */
  const healthy = Effect.fn("OpenCodexManagedUpdate.healthy")(function* (
    alias: string | null,
    targetVersion: string,
    scope: McpInvocationScope,
  ) {
    const window = (yield* Ref.get(state)).window;
    const key = failedTargetKey(alias);
    const snapshot = (yield* host.member(alias, scope)).snapshot;
    const startedAt = snapshot?.parityEvidence?.startedAt;
    const processId = snapshot?.parityEvidence?.processId;
    const expected = window?.startedAt[key];
    const expectedProcess = window?.processIds[key];
    const ok =
      snapshot?.runtime.healthy === true &&
      snapshot.runtime.version === targetVersion &&
      snapshot.runtime.role === window?.roles[key] &&
      snapshot.parityEvidence?.modelsStatus === 200 &&
      startedAt !== undefined &&
      processId !== undefined &&
      (expectedProcess === undefined || processId === expectedProcess) &&
      (expected === undefined || Math.abs(startedAt - expected) <= RESTART_TOLERANCE_MS);
    if (ok && (expected === undefined || expectedProcess === undefined))
      yield* mutate((current) =>
        withWindow(current, (open) => ({
          ...open,
          startedAt: { ...open.startedAt, [key]: startedAt },
          processIds: { ...open.processIds, [key]: processId },
        })),
      );
    return ok;
  });
  const paritySurvives = Effect.fn("OpenCodexManagedUpdate.paritySurvives")(function* (
    aliases: ReadonlyArray<string>,
    scope: McpInvocationScope,
  ) {
    const baseline = (yield* Ref.get(state)).window?.baseline ?? {};
    for (const alias of aliases) {
      const result = yield* parity.verify(alias, scope).pipe(Effect.option);
      if (Option.isNone(result) || brokeAgainst(baseline, alias, result.value)) return false;
    }
    return true;
  });

  /**
   * Home first, then each Child; any failure restores every member this window moved. Every
   * member a step restarts holds admission until the last health check, so no turn starts
   * under an install; a member that cannot hold it keeps the whole window from starting.
   */
  const runWindow = (input: {
    readonly steps: ReadonlyArray<OpenCodexUpdateStep>;
    readonly targetVersion: string;
    readonly members: ReadonlyArray<OpenCodexUpdateMember>;
    readonly children: ReadonlyArray<string>;
    readonly scope: McpInvocationScope;
  }) => {
    const affected = affectedBy(input.steps, input.children);
    return sync.exclusive(holding(affected, moveWindow(input, affected))).pipe(
      Effect.map((result) =>
        result === "admission-unsupported"
          ? {
              outcome: result,
              waitingOn: affected.filter((member) => member !== null),
            }
          : result,
      ),
      Effect.withSpan("OpenCodexManagedUpdate.runWindow"),
    );
  };
  const moveWindow = Effect.fnUntraced(function* (
    input: {
      readonly steps: ReadonlyArray<OpenCodexUpdateStep>;
      readonly targetVersion: string;
      readonly members: ReadonlyArray<OpenCodexUpdateMember>;
      readonly children: ReadonlyArray<string>;
      readonly scope: McpInvocationScope;
    },
    affected: ReadonlyArray<string | null>,
  ) {
    const { steps, targetVersion, scope } = input;
    // ADR-0019's second idle check, now that no new turn can start.
    const busy = (yield* Effect.forEach(affected, (alias) => host.member(alias, scope))).filter(
      ({ runningTurns }) => runningTurns !== 0,
    );
    if (busy.length > 0)
      return { outcome: "busy" as const, waitingOn: busy.map(({ alias }) => alias) };
    const baseline: Record<string, HubParityResult["verdict"]> = {};
    for (const alias of input.children) {
      const result = yield* parity.verify(alias, scope).pipe(Effect.option);
      if (Option.isSome(result)) baseline[alias] = result.value.verdict;
    }
    const roles: Record<string, string> = {};
    for (const member of input.members) {
      const role = member.snapshot?.runtime.role;
      if (role !== undefined) roles[failedTargetKey(member.alias)] = role;
    }
    yield* mutate((current) => ({
      ...current,
      window: {
        targetVersion,
        steps: [],
        children: [...input.children],
        baseline,
        roles,
        startedAt: {},
        processIds: {},
      },
    }));
    yield* sync.beginUpdate(targetVersion);

    for (const [index, step] of steps.entries()) {
      // A Child still waiting for its own step may need the new relay protocol before parity
      // holds again, so only Children already matching the Home are judged here.
      const pending = new Set(steps.slice(index + 1).map(({ alias }) => alias));
      const settled = input.children.filter((alias) => !pending.has(alias));
      yield* mutate((current, at) =>
        withWindow(withRecords(current, at, [step], targetVersion, "installed"), (window) => ({
          ...window,
          steps: [...window.steps, { alias: step.alias, fromVersion: step.fromVersion }],
        })),
      );
      const installed = yield* host.install(step.alias, targetVersion);
      // Before the health check records its process: a Child's sync may restart its runtime.
      // A failed sync is reported in the window's sync report and never rolls the install back.
      if (installed) yield* sync.syncUpdatedMember(step.alias, scope);
      const failure = !installed
        ? "install-failed"
        : !(yield* healthy(step.alias, targetVersion, scope))
          ? "health-failed"
          : !(yield* paritySurvives(step.alias === null ? settled : [step.alias], scope))
            ? "parity-broken"
            : undefined;
      if (failure !== undefined) {
        yield* rollBack(failure, true, scope, step.alias);
        return { outcome: "rolled-back" as const };
      }
      yield* record(step, targetVersion, "probation");
    }
    const now = yield* Clock.currentTimeMillis;
    yield* mutate((current) =>
      withWindow(current, (window) => ({ ...window, probationEndsAt: now + PROBATION_MS })),
    );
    yield* Ref.set(nextAt, now + PROBATION_CHECK_MS);
    return { outcome: "probation" as const };
  });

  /** Advances an open window. Anything but `closed` keeps new plans from starting beside it. */
  const continueWindow = Effect.fn("OpenCodexManagedUpdate.continueWindow")(function* (
    now: number,
    scope: McpInvocationScope,
  ) {
    const current = yield* Ref.get(state);
    const window = current.window;
    if (window === undefined) return "closed" as const;
    const closedOr = (done: boolean): Effect.Effect<"closed" | "restoring"> =>
      done
        ? Effect.succeed("closed")
        : Ref.set(nextAt, now + RETRY_INTERVAL_MS).pipe(Effect.as("restoring"));
    if (window.restoring !== undefined)
      return yield* closedOr(yield* rollBack(window.restoring, false, scope));
    // GOAT stopped between an install and its health check; that member is unproven.
    if (
      window.probationEndsAt === undefined ||
      window.steps.some(
        ({ alias }) => phaseOf(current, alias, window.targetVersion) === "installed",
      )
    )
      return yield* closedOr(yield* rollBack("interrupted", true, scope));
    for (const step of window.steps) {
      if (!(yield* healthy(step.alias, window.targetVersion, scope)))
        return yield* closedOr(yield* rollBack("probation-health-failed", true, scope, step.alias));
    }
    if (now < window.probationEndsAt) {
      yield* Ref.set(nextAt, Math.min(window.probationEndsAt, now + PROBATION_CHECK_MS));
      return "probation" as const;
    }
    if (!(yield* paritySurvives(window.children, scope)))
      return yield* closedOr(yield* rollBack("probation-parity-broken", true, scope));
    yield* mutate((latest, at) =>
      withWindow(
        withRecords(latest, at, window.steps, window.targetVersion, "accepted"),
        () => undefined,
      ),
    );
    yield* Effect.logInfo("opencodex.update.accepted", {
      targetVersion: window.targetVersion,
      members: window.steps.length,
    });
    return "closed" as const;
  });

  const publish = (
    checkedAt: number,
    plan: Pick<OpenCodexUpdateStatus, "decision" | "reason"> &
      Partial<Omit<OpenCodexUpdateStatus, "checkedAt" | "members">>,
  ) =>
    Ref.get(state).pipe(
      Effect.flatMap((current) =>
        Ref.set(status, {
          checkedAt,
          waitingOn: [],
          advisories: [],
          ...plan,
          members: current.members,
        }),
      ),
    );

  const runCheck = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (now < (yield* Ref.get(nextAt))) return;
    yield* Ref.set(nextAt, now + RETRY_INTERVAL_MS);
    const configured = yield* settings.getSettings.pipe(Effect.option);
    if (
      Option.isNone(configured) ||
      !configured.value.hub.enabled ||
      !configured.value.goatclaw.enabled
    )
      return;
    const stored = yield* readState;
    if (stored === undefined)
      return yield* publish(now, { decision: "wait", reason: "state-unreadable" });
    yield* Ref.set(state, stored);
    yield* sync.markUpdating(stored.window !== undefined);

    const scope: McpInvocationScope = {
      environmentId,
      capabilities: new Set(["orchestration"]),
      issuedAt: now,
      requestNamespace: "opencodex-update",
      thread: undefined,
      client: {
        sessionId: "opencodex-update",
        label: "GOAT OpenCodex update",
        access: "read-only",
      },
    };
    const home = yield* host.member(null, scope);
    if (home.snapshot?.link.role === "child") {
      // The Home coordinates its Children; a Child never moves on its own schedule.
      yield* Ref.set(nextAt, now + CHECK_INTERVAL_MS);
      return yield* publish(now, { decision: "none", reason: "coordinated-by-home" });
    }
    const childAliases =
      home.snapshot?.link.role === "home" ? home.snapshot.link.links.map(({ alias }) => alias) : [];
    const open = yield* continueWindow(now, scope);
    if (open !== "closed")
      return yield* publish(now, {
        decision: open === "probation" ? "update" : "wait",
        reason: open === "probation" ? "probation" : "rollback-incomplete",
        targetVersion: stored.window!.targetVersion,
      });
    // This check closed a window: its Home and Child readings predate the rollback or acceptance.
    if (stored.window !== undefined)
      return yield* publish(now, { decision: "none", reason: "window-closed" });
    const children = yield* Effect.forEach(childAliases, (alias) => host.member(alias, scope));

    // Busy retries every 10 minutes must not refetch the registry document each time.
    const cached = yield* Ref.get(release);
    let latest = cached?.value;
    if (cached === undefined || now - cached.at >= CHECK_INTERVAL_MS) {
      latest = yield* host.latestRelease;
      yield* Ref.set(release, { at: now, value: latest });
    }
    const rolledOut =
      latest !== undefined &&
      isRolloutEligible({
        channel: "stable",
        bucket: yield* rolloutBucket(environmentId, latest.version).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
        ),
        publishedAt: latest.publishedAt,
        now,
      });
    const plan = planOpenCodexUpdate({
      home,
      children,
      targetVersion: rolledOut ? latest?.version : undefined,
      failedTargets: (yield* Ref.get(state)).failedTargets,
    });
    const summary = {
      decision: plan.decision,
      reason: latest !== undefined && !rolledOut ? "rollout-pending" : plan.reason,
      waitingOn: plan.waitingOn,
      advisories: plan.advisories,
      ...(latest === undefined ? {} : { targetVersion: latest.version }),
    };
    if (plan.decision !== "wait") yield* Ref.set(nextAt, now + CHECK_INTERVAL_MS);
    if (plan.decision !== "update" || plan.targetVersion === undefined)
      return yield* publish(now, summary);

    const result = yield* runWindow({
      steps: plan.steps,
      targetVersion: plan.targetVersion,
      members: [home, ...children],
      children: childAliases,
      scope,
    });
    if (result.outcome === "busy" || result.outcome === "admission-unsupported") {
      // Unsupported admission is structural; it waits for the next release check.
      if (result.outcome === "busy") yield* Ref.set(nextAt, now + RETRY_INTERVAL_MS);
      return yield* publish(now, {
        ...summary,
        decision: "wait",
        reason: result.outcome,
        waitingOn: result.waitingOn,
      });
    }
    const restoring = (yield* Ref.get(state)).window?.restoring !== undefined;
    if (restoring) yield* Ref.set(nextAt, now + RETRY_INTERVAL_MS);
    yield* publish(
      yield* Clock.currentTimeMillis,
      restoring ? { ...summary, decision: "wait", reason: "rollback-incomplete" } : summary,
    );
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("opencodex.update.failed", { cause })),
    Effect.withSpan("OpenCodexManagedUpdate.check"),
  );

  /** The update window's sync report joins the status only for a window this status records. */
  const readStatus = Effect.gen(function* () {
    const current = yield* Ref.get(status);
    const synced = yield* sync.lastUpdate;
    return current !== undefined &&
      synced !== undefined &&
      current.members.some(({ targetVersion }) => targetVersion === synced.targetVersion)
      ? { ...current, sync: synced }
      : current;
  });
  const check = checking.withPermit(runCheck);
  const checkNow = checking
    .withPermit(Ref.set(nextAt, 0).pipe(Effect.andThen(runCheck)))
    .pipe(Effect.andThen(readStatus), Effect.withSpan("OpenCodexManagedUpdate.checkNow"));

  return OpenCodexManagedUpdate.of({ status: readStatus, check, checkNow });
});

/**
 * Registered once on the shared Scheduler; with hub or goatclaw off it does nothing. Needs the
 * shared OpenCodexSync and OpenCodexUpdateHost, which McpHttpServer provides once for every user.
 */
export const layerService = Layer.effect(
  OpenCodexManagedUpdate,
  Effect.gen(function* () {
    const service = yield* make;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("opencodex-managed-update", service.check);
    return service;
  }),
);
