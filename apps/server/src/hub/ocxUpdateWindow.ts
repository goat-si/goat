import { type HubParityResult, OpenCodexUpdateMemberRecord } from "@goat/contracts";
import * as Schema from "effect/Schema";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as PlatformError from "effect/PlatformError";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import type { OpenCodexUpdateHost } from "./OpenCodexUpdateHost.ts";
import { failedTargetKey } from "./opencodexUpdatePlan.ts";
import type { OpenCodexUpdateStep } from "./opencodexUpdatePlan.ts";

import type { OrchestratedPlan } from "./ocxContracts.ts";

export const OrchestratedWindowEntry = Schema.Struct({
  fromVersion: Schema.String,
  planToken: Schema.String,
  notAfter: Schema.Number,
  boundMs: Schema.Number,
  pending: Schema.optional(Schema.Literal(true)),
  uncertain: Schema.optional(Schema.Literal(true)),
  settled: Schema.optional(Schema.Literal(true)),
  observed: Schema.optional(
    Schema.Struct({
      version: Schema.String,
      processId: Schema.Number,
      startedAt: Schema.Number,
      at: Schema.optional(Schema.Number),
    }),
  ),
});

const samePlan = (before: OrchestratedPlan, after: OrchestratedPlan) =>
  after.canApply &&
  !after.updateInFlight &&
  before.planToken === after.planToken &&
  before.currentVersion === after.currentVersion &&
  before.targetVersion === after.targetVersion &&
  before.servingPath === after.servingPath &&
  before.cliPath === after.cliPath;

export const State = Schema.Struct({
  members: Schema.Array(OpenCodexUpdateMemberRecord),
  failedTargets: Schema.Record(Schema.String, Schema.String),
  runtimeUpdateChecked: Schema.optional(Schema.String),
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
          started: Schema.optional(Schema.Boolean),
          via: Schema.optional(Schema.Literals(["managed", "ocx-update"])),
        }),
      ),
      orchestrated: Schema.optional(Schema.Record(Schema.String, OrchestratedWindowEntry)),
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
export type State = typeof State.Type;
export const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(State));
export const encodeState = Schema.encodeSync(Schema.fromJsonString(State));

export const brokeAgainst = (
  baseline: Readonly<Record<string, HubParityResult["verdict"]>>,
  alias: string,
  result: HubParityResult,
) => result.verdict === "broken" && baseline[alias] !== "broken";

export type Window = NonNullable<State["window"]>;

export const withRecords = (
  current: State,
  at: number,
  steps: ReadonlyArray<Pick<OpenCodexUpdateStep, "alias" | "fromVersion">>,
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
export const withWindow = (
  current: State,
  change: (window: Window) => Window | undefined,
): State => {
  const { window, ...rest } = current;
  const next = window === undefined ? undefined : change(window);
  return next === undefined ? rest : { ...rest, window: next };
};

export const phaseOf = (current: State, alias: string | null, targetVersion: string) =>
  current.members.find((entry) => entry.alias === alias && entry.targetVersion === targetVersion)
    ?.phase;
/** Restarting the Home cuts every Child's routing, so a Home step affects all of them. */
export const affectedBy = (
  steps: ReadonlyArray<{ readonly alias: string | null }>,
  children: ReadonlyArray<string>,
): ReadonlyArray<string | null> =>
  steps.some(({ alias }) => alias === null) ? [null, ...children] : steps.map(({ alias }) => alias);

const MINUTE = 60_000;
const APPLY_START_MS = 5 * MINUTE;
const OVERRUN_GRACE_MS = 30 * MINUTE;
const RETRY_INTERVAL_MS = 10 * MINUTE;
const PROBATION_MS = 10 * MINUTE;
const PROBATION_CHECK_MS = MINUTE;
const RESTART_TOLERANCE_MS = 2_000;

type Host = Context.Service.Shape<typeof OpenCodexUpdateHost>;
export type AdmissionOwnership = "none" | "held" | "retained" | "held-and-retained";
type Step = Pick<OpenCodexUpdateStep, "alias" | "fromVersion">;
type Failure = PlatformError.PlatformError;
type WindowOps = {
  readonly host: Host;
  readonly retainedHome: Ref.Ref<AdmissionOwnership>;
  readonly nextAt: Ref.Ref<number>;
  readonly mutate: (change: (current: State, at: number) => State) => Effect.Effect<void, Failure>;
  readonly record: (
    step: Step,
    target: string,
    phase: OpenCodexUpdateMemberRecord["phase"],
    reason?: string,
  ) => Effect.Effect<void, Failure>;
  readonly rollBack: (
    reason: string,
    remember: boolean,
    scope: McpInvocationScope,
    alias?: string | null,
  ) => Effect.Effect<boolean, Failure>;
  readonly healthProof: (
    alias: string | null,
    version: string,
    scope: McpInvocationScope,
  ) => Effect.Effect<
    { readonly startedAt: number; readonly processId: number } | undefined,
    Failure
  >;
};

const releaseRetained = Effect.fn("OpenCodexUpdateWindow.releaseRetained")(function* (
  host: Host,
  retainedHome: Ref.Ref<AdmissionOwnership>,
) {
  const ownership = yield* Ref.get(retainedHome);
  if (ownership === "retained" || ownership === "held-and-retained") {
    yield* host.releaseAdmission(null);
    yield* Ref.set(retainedHome, ownership === "held-and-retained" ? "held" : "none");
  }
});

export const restoreAdmission = Effect.fn("OpenCodexUpdateWindow.restoreAdmission")(function* (
  initial: State | undefined,
  host: Host,
  retainedHome: Ref.Ref<AdmissionOwnership>,
) {
  if (initial === undefined) return;
  const pending = initial.window?.orchestrated?.[""];
  const unsettled = (pending?.pending || pending?.uncertain) && !pending.settled;
  const ownership = yield* Ref.get(retainedHome);
  if (!unsettled && (ownership === "retained" || ownership === "held-and-retained")) {
    yield* releaseRetained(host, retainedHome).pipe(Effect.uninterruptible);
  } else if (unsettled && ownership === "none") {
    const now = yield* Clock.currentTimeMillis;
    if (now < pending.notAfter + pending.boundMs + OVERRUN_GRACE_MS)
      yield* host.holdAdmission(null).pipe(
        Effect.flatMap((held) => (held ? Ref.set(retainedHome, "retained") : Effect.void)),
        Effect.uninterruptible,
      );
  }
});

export const releaseOverrun = Effect.fn("OpenCodexUpdateWindow.releaseOverrun")(function* (
  current: State,
  host: Host,
  retainedHome: Ref.Ref<AdmissionOwnership>,
  now: number,
) {
  const entry = current.window?.orchestrated?.[""];
  if (
    entry === undefined ||
    entry.settled ||
    (!entry.pending && !entry.uncertain) ||
    now < entry.notAfter + entry.boundMs + OVERRUN_GRACE_MS
  )
    return false;
  yield* releaseRetained(host, retainedHome).pipe(Effect.uninterruptible);
  return true;
});

export const holdAffected = <A, E>(
  host: Host,
  retainedHome: Ref.Ref<AdmissionOwnership>,
  affected: ReadonlyArray<string | null>,
  body: Effect.Effect<A, E>,
) => {
  const held: Array<string | null> = [];
  return Effect.gen(function* () {
    for (const alias of affected) {
      if (alias === null && (yield* Ref.get(retainedHome)) !== "none") continue;
      const acquired = yield* Effect.gen(function* () {
        if (!(yield* host.holdAdmission(alias))) return false;
        held.push(alias);
        if (alias === null) yield* Ref.set(retainedHome, "held");
        return true;
      }).pipe(Effect.uninterruptible);
      if (!acquired) return "admission-unsupported" as const;
    }
    return yield* body;
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        Effect.forEach(
          held,
          (alias) =>
            alias === null
              ? Ref.get(retainedHome).pipe(
                  Effect.flatMap((ownership) =>
                    ownership === "held" || ownership === "held-and-retained"
                      ? host
                          .releaseAdmission(null)
                          .pipe(
                            Effect.andThen(
                              Ref.set(retainedHome, ownership === "held" ? "none" : "retained"),
                            ),
                          )
                      : Effect.void,
                  ),
                )
              : host.releaseAdmission(alias),
          { discard: true },
        ),
      ),
    ),
  );
};

export const applyOrchestratedStep = Effect.fn("OpenCodexUpdateWindow.apply")(function* (
  ops: WindowOps,
  step: Step,
  targetVersion: string,
  scope: McpInvocationScope,
  original: OrchestratedPlan | undefined,
) {
  const { host, mutate, retainedHome, nextAt, rollBack } = ops;
  const fresh = yield* host.orchestratedPlan(step.alias, targetVersion);
  if (original === undefined || fresh.kind !== "plan" || !samePlan(original, fresh.plan)) {
    yield* rollBack("install-refused", false, scope, step.alias);
    return "rolled-back" as const;
  }
  const notAfter = (yield* Clock.currentTimeMillis) + APPLY_START_MS;
  const key = failedTargetKey(step.alias);
  const base = {
    fromVersion: step.fromVersion,
    planToken: fresh.plan.planToken,
    notAfter,
    boundMs: fresh.plan.mutationBoundMs,
  };
  yield* mutate((current) =>
    withWindow(current, (window) => ({
      ...window,
      orchestrated: { ...window.orchestrated, [key]: { ...base, pending: true } },
    })),
  );
  if (step.alias === null && (yield* Ref.get(retainedHome)) === "held") {
    const retained = yield* host.holdAdmission(null).pipe(
      Effect.flatMap((held) =>
        held
          ? Ref.set(retainedHome, "held-and-retained").pipe(Effect.as(true))
          : Effect.succeed(false),
      ),
      Effect.uninterruptible,
    );
    if (!retained) {
      yield* mutate((current) =>
        withWindow(current, (window) => ({
          ...window,
          orchestrated: { ...window.orchestrated, [key]: { ...base, settled: true } },
        })),
      );
      yield* rollBack("install-refused", false, scope, step.alias);
      return "rolled-back" as const;
    }
  }
  const outcome = yield* host.applyOrchestrated(
    step.alias,
    targetVersion,
    fresh.plan.planToken,
    notAfter,
  );
  if (outcome === "uncertain") {
    yield* mutate((current) =>
      withWindow(current, (window) => ({
        ...window,
        orchestrated: { ...window.orchestrated, [key]: { ...base, uncertain: true } },
      })),
    );
    yield* Ref.set(nextAt, (yield* Clock.currentTimeMillis) + RETRY_INTERVAL_MS);
    return "uncertain" as const;
  }
  yield* Effect.gen(function* () {
    if (step.alias === null) yield* releaseRetained(host, retainedHome);
    yield* mutate((current) =>
      withWindow(current, (window) => ({
        ...window,
        orchestrated: { ...window.orchestrated, [key]: { ...base, settled: true } },
      })),
    );
  }).pipe(Effect.uninterruptible);
  if (outcome === "refused" || outcome === "rolled-back") {
    yield* rollBack(
      outcome === "refused" ? "install-refused" : "install-failed",
      outcome === "rolled-back",
      scope,
      step.alias,
    );
    return "rolled-back" as const;
  }
  return "applied" as const;
});

export const recoverUncertain = Effect.fn("OpenCodexUpdateWindow.recover")(function* (
  ops: WindowOps,
  current: State,
  now: number,
  scope: McpInvocationScope,
) {
  const { host, retainedHome, nextAt, mutate, record, rollBack, healthProof } = ops;
  const window = current.window;
  if (window === undefined) return undefined;
  const closedOr = (done: boolean): Effect.Effect<"closed" | "restoring"> =>
    done
      ? Effect.succeed("closed")
      : Ref.set(nextAt, now + RETRY_INTERVAL_MS).pipe(Effect.as("restoring"));
  const uncertain = window.steps.find((step) => {
    const entry = window.orchestrated?.[failedTargetKey(step.alias)];
    return entry?.pending || entry?.uncertain;
  });
  if (uncertain !== undefined) {
    const key = failedTargetKey(uncertain.alias);
    const entry = window.orchestrated?.[key];
    if (entry === undefined) return "uncertain" as const;
    if (entry.settled) {
      const snapshot = (yield* host.member(uncertain.alias, scope)).snapshot;
      if (snapshot?.runtime.version === entry.fromVersion) {
        yield* mutate((latest) =>
          withWindow(latest, (open) => ({
            ...open,
            orchestrated: {
              ...open.orchestrated,
              [key]: {
                fromVersion: entry.fromVersion,
                planToken: entry.planToken,
                notAfter: entry.notAfter,
                boundMs: entry.boundMs,
                settled: true,
              },
            },
          })),
        );
        return yield* closedOr(yield* rollBack("install-failed", true, scope, uncertain.alias));
      }
      yield* Ref.set(nextAt, now + RETRY_INTERVAL_MS);
      return "uncertain" as const;
    }
    const releaseHome =
      uncertain.alias === null ? releaseRetained(host, retainedHome) : Effect.void;
    if (
      uncertain.alias === null &&
      now >= entry.notAfter + entry.boundMs + OVERRUN_GRACE_MS &&
      current.members.find((member) => member.alias === null)?.reason !== "apply-overrun"
    ) {
      yield* releaseHome.pipe(Effect.uninterruptible);
      yield* record(uncertain, window.targetVersion, "rollback-failed", "apply-overrun");
      yield* Effect.logWarning("opencodex.update.apply-overrun", { alias: uncertain.alias });
    }
    const plan = yield* host.orchestratedPlan(uncertain.alias, window.targetVersion);
    const snapshot = (yield* host.member(uncertain.alias, scope)).snapshot;
    const version = snapshot?.runtime.version;
    const processId = snapshot?.parityEvidence?.processId;
    const startedAt = snapshot?.parityEvidence?.startedAt;
    const observed = entry.observed;
    const canObserve =
      now >= entry.notAfter + entry.boundMs &&
      plan.kind === "plan" &&
      !plan.plan.updateInFlight &&
      version !== undefined &&
      processId !== undefined &&
      startedAt !== undefined;
    if (!canObserve) {
      if (observed !== undefined)
        yield* mutate((latest) =>
          withWindow(latest, (open) => {
            const { observed: _observed, ...rest } = entry;
            return { ...open, orchestrated: { ...open.orchestrated, [key]: rest } };
          }),
        );
      yield* Ref.set(nextAt, now + RETRY_INTERVAL_MS);
      return "uncertain" as const;
    }
    const matches =
      observed !== undefined &&
      observed.at !== undefined &&
      observed.version === version &&
      observed.processId === processId &&
      Math.abs(observed.startedAt - startedAt) <= RESTART_TOLERANCE_MS;
    if (!matches) {
      yield* mutate((latest) =>
        withWindow(latest, (open) => ({
          ...open,
          orchestrated: {
            ...open.orchestrated,
            [key]: { ...entry, observed: { version, processId, startedAt, at: now } },
          },
        })),
      );
      yield* Ref.set(nextAt, now + RETRY_INTERVAL_MS);
      return "uncertain" as const;
    }
    if (observed?.at !== undefined && now < observed.at + RETRY_INTERVAL_MS) {
      yield* Ref.set(nextAt, observed.at + RETRY_INTERVAL_MS);
      return "uncertain" as const;
    }
    const restoring = version === entry.fromVersion;
    const proof =
      !restoring &&
      version === window.targetVersion &&
      window.steps.at(-1)?.alias === uncertain.alias
        ? yield* healthProof(uncertain.alias, version, scope)
        : undefined;
    const phase = restoring
      ? undefined
      : proof === undefined
        ? ("rollback-failed" as const)
        : ("probation" as const);
    const settled = {
      fromVersion: entry.fromVersion,
      planToken: entry.planToken,
      notAfter: entry.notAfter,
      boundMs: entry.boundMs,
      settled: true as const,
    };
    yield* Effect.gen(function* () {
      yield* releaseHome;
      yield* mutate((latest, at) => {
        const recorded =
          phase === undefined
            ? latest
            : withRecords(
                latest,
                at,
                [uncertain],
                window.targetVersion,
                phase,
                phase === "rollback-failed" ? "apply-uncertain" : undefined,
              );
        const withFailures = restoring
          ? {
              ...recorded,
              failedTargets: {
                ...recorded.failedTargets,
                ...Object.fromEntries(
                  window.steps
                    .filter((step) => step.via === undefined || step.started === true)
                    .map(({ alias }) => [failedTargetKey(alias), window.targetVersion]),
                ),
              },
            }
          : recorded;
        return withWindow(withFailures, (open) => ({
          ...open,
          ...(restoring ? { restoring: "install-failed" } : {}),
          ...(proof === undefined
            ? {}
            : {
                probationEndsAt: now + PROBATION_MS,
                startedAt: { ...open.startedAt, [key]: proof.startedAt },
                processIds: { ...open.processIds, [key]: proof.processId },
              }),
          orchestrated: {
            ...open.orchestrated,
            [key]: phase === "rollback-failed" ? { ...settled, uncertain: true } : settled,
          },
        }));
      });
    }).pipe(Effect.uninterruptible);
    if (restoring)
      return yield* closedOr(yield* rollBack("install-failed", true, scope, uncertain.alias));
    if (proof !== undefined) {
      yield* Ref.set(nextAt, now + PROBATION_CHECK_MS);
      return "probation" as const;
    }
    yield* Ref.set(nextAt, now + RETRY_INTERVAL_MS);
    return "uncertain" as const;
  }
  return undefined;
});
