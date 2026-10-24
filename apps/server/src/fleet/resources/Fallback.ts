/**
 * Model fallback chains. `next` walks a chain for the goal controller; `continueThread` is
 * the branch of the usage-limit recovery sweep that moves an ordinary thread to its chain's
 * next model, so one scheduler source decides one command per failed run.
 * Cooldowns live in memory: losing them on restart only retries a step early.
 *
 * @module Fallback
 */
import {
  CommandId,
  ServerSettingsError,
  DEFAULT_FALLBACK_COOLDOWN_MS,
  MessageId,
  type FallbackChainStep,
  type FallbackFailure,
  type FleetSettings,
  type GoatFallbackChainGetResult,
  type GoatFallbackChainSetInput,
  type GoatFallbackChainSetResult,
  type ModelSelection,
  type ThreadId,
} from "@goat/contracts";
import { modelSelectionCommandType, modelSelectionsEqual } from "@goat/shared/model";
import {
  latestExecutedRun,
  latestRootProviderFailure,
  threadErrorSummary,
} from "@goat/shared/orchestrationV2ThreadError";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { isExhausted } from "../../channels/channelPlacement.ts";
import * as ProviderSwitch from "../../orchestration-v2/ProviderSwitchService.ts";
import { FallbackSelectionSource } from "../../orchestration-v2/goat/FallbackSelection.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import {
  anyThreadChain,
  decideNext,
  failedTail,
  ordinaryThreadChain,
  stepKey,
  toSelection,
} from "./fallbackPolicy.ts";
import { goatCallText } from "@goat/contracts/agentSurface/callText";

export type FallbackStep =
  | { readonly _tag: "SwitchInThread"; readonly selection: ModelSelection; readonly hop: number }
  | { readonly _tag: "Relaunch"; readonly selection: ModelSelection; readonly hop: number }
  | { readonly _tag: "Exhausted"; readonly reason: string };

export interface FallbackCooldown {
  readonly instanceId: ModelSelection["instanceId"];
  readonly model: string;
  readonly failure: FallbackFailure;
  readonly until: string;
}

export interface FallbackShape {
  readonly next: (input: {
    readonly chain: string | null;
    readonly selection: ModelSelection;
    readonly failure: FallbackFailure;
    readonly tried: ReadonlyArray<ModelSelection>;
    readonly host: string | null;
    readonly threadId: ThreadId | null;
  }) => Effect.Effect<FallbackStep>;
  /** Starts the step's cooldown, from `failedAt` (epoch ms) when given. */
  readonly reportFailure: (
    selection: ModelSelection,
    failure: FallbackFailure,
    failedAt?: number,
  ) => Effect.Effect<void>;
  readonly cooldowns: Effect.Effect<ReadonlyArray<FallbackCooldown>>;
  /** Whether any chain opted into ordinary threads, so the recovery sweep looks for them. */
  readonly coversThreads: Effect.Effect<boolean>;
  /**
   * Moves an ordinary thread with a configured failure trigger to its chain's next model, with a
   * notice and a continuation. True when it switched; false leaves the thread to the recovery
   * sweep's wait-for-reset.
   */
  readonly continueThread: (threadId: ThreadId) => Effect.Effect<boolean>;
}

export class Fallback extends Context.Service<Fallback, FallbackShape>()(
  "goat/fleet/resources/Fallback",
) {}

/**
 * Whether a thread belongs to a goal, whose controller owns its failures. The goal controller
 * provides it; until then no thread is a goal thread.
 */
export const GoalThreadOwnership = Context.Reference<{
  readonly isGoalThread: (threadId: ThreadId) => Effect.Effect<boolean>;
}>("goat/fleet/resources/Fallback/GoalThreadOwnership", {
  defaultValue: () => ({ isGoalThread: () => Effect.succeed(false) }),
});

/** Selection attempts per step of one failed run before it is skipped for that run. */
const MAX_SELECT_ATTEMPTS = 20;

/** Runs remembered as already told that nothing could be switched. */
const MAX_NOTICED_RUNS = 1000;

const label = (selection: Pick<ModelSelection, "instanceId" | "model">) =>
  selection.instanceId + "/" + selection.model;

export const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  const switches = yield* Effect.serviceOption(ProviderSwitch.ProviderSwitchServiceV2);
  const cooldownState = yield* Ref.make(new Map<string, FallbackCooldown>());
  const noticed = yield* Ref.make(new Set<string>());

  const fleetSettings = settingsService.getSettings.pipe(
    Effect.map((settings) => settings.fleet),
    Effect.orElseSucceed((): FleetSettings => ({})),
  );
  const nowMs = Effect.map(DateTime.now, DateTime.toEpochMillis);
  const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
  /** A snoozed thread wakes on its own schedule; a continuation would wake it now. */
  const snoozed = (shell: { readonly snoozedUntil?: DateTime.Utc | null | undefined }) =>
    Effect.map(
      nowMs,
      (now) => shell.snoozedUntil != null && DateTime.toEpochMillis(shell.snoozedUntil) > now,
    );

  const chainFor = (settings: FleetSettings, id: string) => settings.fallbackChains?.[id];

  /** Why a step cannot be used on this machine now, or undefined. */
  const unavailability = Effect.gen(function* () {
    const now = yield* nowMs;
    const cooling = yield* Ref.get(cooldownState);
    const providers = Option.isSome(registry) ? yield* registry.value.getProviders : undefined;
    return (step: FallbackChainStep, current: string, local: boolean) => {
      const cooldown = cooling.get(stepKey(step));
      if (cooldown !== undefined && Date.parse(cooldown.until) > now)
        return "is cooling down until " + cooldown.until;
      // Only this machine's providers are known here; placement checks a remote's.
      if (!local || providers === undefined) return undefined;
      const provider = providers.find((candidate) => candidate.instanceId === step.instanceId);
      if (provider === undefined) return "is not configured here";
      if (!provider.enabled) return "is disabled";
      // One instance can route several accounts (opencodex routes); its windows then
      // describe whichever account failed, so they only rule out another instance.
      const windows = provider.usageLimits?.windows ?? [];
      if (
        step.instanceId !== current &&
        windows.length > 0 &&
        isExhausted(
          {
            value: null,
            host: null,
            providerLabel: step.instanceId,
            preferred: false,
            windows: windows.map((window) => ({
              label: window.label,
              usedPercent: window.usedPercent,
              ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
            })),
            activeTasks: 0,
          },
          now,
        )
      )
        return "is at its usage limit";
      return undefined;
    };
  });

  const reportFailure: FallbackShape["reportFailure"] = (selection, failure, failedAt) =>
    Effect.gen(function* () {
      const settings = yield* fleetSettings;
      const cooldownMs =
        Object.values(settings.fallbackChains ?? {})
          .filter((chain) => chain.steps.some((step) => stepKey(step) === stepKey(selection)))
          .map((chain) => chain.cooldownMs ?? DEFAULT_FALLBACK_COOLDOWN_MS)
          .toSorted((left, right) => right - left)[0] ?? DEFAULT_FALLBACK_COOLDOWN_MS;
      const now = yield* nowMs;
      // Counted from when the step failed, so reporting the same failure again on every
      // sweep never pushes the end of its cooldown out.
      const until = (failedAt ?? now) + cooldownMs;
      yield* Ref.update(cooldownState, (current) => {
        const next = new Map([...current].filter(([, entry]) => Date.parse(entry.until) > now));
        const existing = next.get(stepKey(selection));
        if (existing !== undefined && Date.parse(existing.until) >= until) return next;
        if (until <= now) return next;
        next.set(stepKey(selection), {
          instanceId: selection.instanceId,
          model: selection.model,
          failure,
          until: iso(until),
        });
        return next;
      });
    });

  /** Checks the local thread's switch with ProviderSwitchService; remote hosts switch in place. */
  const canSwitch = (threadId: ThreadId | null, host: string | null, target: ModelSelection) =>
    threadId === null || host !== null || Option.isNone(switches)
      ? Effect.succeed(true)
      : threads.getThreadRecords(threadId, ["providerSessions", "providerThreads"]).pipe(
          Effect.flatMap((projection) =>
            switches.value.plan({ projection, targetModelSelection: target }),
          ),
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );

  const next: FallbackShape["next"] = (input) =>
    Effect.gen(function* () {
      const settings = yield* fleetSettings;
      const id = input.chain ?? settings.defaultFallbackChain ?? null;
      const chain = id === null ? undefined : chainFor(settings, id);
      if (chain === undefined)
        return {
          _tag: "Exhausted",
          reason: id === null ? "no fallback chain" : "fallback chain " + id + " is not configured",
        } as const;
      const unavailable = yield* unavailability;
      const decision = decideNext({
        chain,
        current: input.selection,
        failure: input.failure,
        tried: input.tried,
        unavailable: (step) => unavailable(step, input.selection.instanceId, input.host === null),
      });
      if (decision._tag === "Exhausted") return decision;
      const selection = toSelection(decision.step);
      return (yield* canSwitch(input.threadId, input.host, selection))
        ? ({ _tag: "SwitchInThread", selection, hop: decision.hop } as const)
        : ({ _tag: "Relaunch", selection, hop: decision.hop } as const);
    });

  const notice = (threadId: ThreadId, key: string, message: string) =>
    threads
      .dispatch({
        type: "thread.notice.record",
        commandId: CommandId.make("fleet-fallback-notice:" + key),
        threadId,
        recordKey: "fleet-fallback:" + key,
        message,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("fleet.fallback.notice-failed", { threadId, cause }),
        ),
      );

  const noticeOnce = (threadId: ThreadId, runId: string, chainId: string, reason: string) =>
    Effect.gen(function* () {
      const seen = yield* Ref.modify(noticed, (current) => [
        current.has(runId),
        (current.size >= MAX_NOTICED_RUNS ? new Set<string>() : new Set(current)).add(runId),
      ]);
      // After a restart the repeat replays its command receipt and adds nothing.
      if (!seen)
        yield* notice(
          threadId,
          "wait:" + runId,
          "Fallback chain " + chainId + " did not switch models: " + reason + ".",
        );
    });

  const continueThread: FallbackShape["continueThread"] = (threadId) =>
    Effect.gen(function* () {
      const settings = yield* fleetSettings;
      const ownership = yield* GoalThreadOwnership;
      if (yield* ownership.isGoalThread(threadId)) return false;
      const shell = yield* threads.getThreadShell(threadId);
      if (
        shell === null ||
        shell.archivedAt !== null ||
        shell.deletedAt !== null ||
        shell.settledOverride === "settled" ||
        shell.pendingRuntimeRequest != null ||
        (yield* snoozed(shell))
      )
        return false;
      const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
      const failedRun = latestExecutedRun(runs);
      if (failedRun?.status !== "failed") return false;
      const runId = failedRun.id;
      const continuation = "fleet-fallback:" + threadId + ":" + runId + ":continue";
      // A completed hop owns this run even if the chain or selection changed since delivery.
      if ((yield* threads.receiptStatus(CommandId.make(continuation))) === "accepted") return true;
      if (runs.some((run) => run.status === "queued")) return false;
      const { turnItems, providerSessions } = yield* threads.getThreadRecords(
        threadId,
        ["turnItems", "providerSessions"],
        {
          turnItemTypes: ["error", "run_interrupt_request"],
          turnItemRunIds: [runId],
        },
      );
      if (
        turnItems.some((item) => item.type === "run_interrupt_request") ||
        (shell.limitRecovery?.runId === runId &&
          !shell.limitRecovery.autoResume &&
          !shell.limitRecovery.snooze)
      )
        return false;
      const session = providerSessions
        .filter((entry) => entry.providerInstanceId === shell.providerInstanceId)
        .toSorted(
          (left, right) =>
            DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt) ||
            right.id.localeCompare(left.id),
        )[0];
      const summary = threadErrorSummary(
        latestRootProviderFailure(failedRun, turnItems),
        session?.lastError ?? null,
      );
      const failure = summary.lastErrorClass;
      if (failure === null) return false;
      // A restart after selection must resolve the original chain and replay that hop's receipts.
      const current = failedRun.modelSelection;
      const resolved = ordinaryThreadChain(settings, current);
      if (resolved === null) return false;
      const tried = failedTail(runs);
      const failedAt =
        failedRun.completedAt === null ? undefined : DateTime.toEpochMillis(failedRun.completedAt);
      yield* reportFailure(current, failure, failedAt);
      /** Re-checks the thread, then the notice and the continuation, both fixed per run. */
      const announce = (target: ModelSelection, hop: number) =>
        Effect.gen(function* () {
          // The user may have settled, snoozed, stopped, or redirected the thread meanwhile.
          // This read skips the notice; automatedContinuationOfRunId makes the orchestrator
          // refuse a continuation that loses the race after it.
          const latest = yield* threads.getThreadShell(threadId);
          const latestRuns = yield* threads.getThreadRecords(threadId, ["runs"]);
          const latestExecuted = latestExecutedRun(latestRuns.runs);
          if (
            latest === null ||
            latestExecuted?.id !== runId ||
            latestExecuted.status !== "failed" ||
            latest.archivedAt !== null ||
            latest.settledOverride === "settled" ||
            latest.pendingRuntimeRequest != null ||
            (yield* snoozed(latest)) ||
            !modelSelectionsEqual(latest.modelSelection, target)
          )
            return;
          yield* Effect.logInfo("fleet.fallback.hop", {
            threadId,
            runId,
            from: label(current),
            to: label(target),
            hop,
          });
          yield* notice(
            threadId,
            "switch:" + runId,
            "Switched to " +
              label(target) +
              " after " +
              failure +
              " on " +
              label(current) +
              (summary.usageLimitResetAt == null
                ? ""
                : "; that limit resets at " + summary.usageLimitResetAt) +
              " (fallback chain " +
              resolved.id +
              ").",
          );
          yield* threads.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(continuation),
            messageId: MessageId.make(continuation),
            threadId,
            automatedContinuationOfRunId: runId,
            modelSelection: target,
            text: "Continue where you left off.",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "server",
          });
        });
      /**
       * The selection attempts for one step of this failed run: the first uses a fixed id, and
       * each retry after a rejection the next numbered one, so a rejected receipt never
       * replays over a later try and an accepted one is found however long ago it landed.
       */
      const attempts = (target: Pick<ModelSelection, "instanceId" | "model">) =>
        Effect.gen(function* () {
          const base = "fleet-fallback:" + threadId + ":" + runId + ":" + stepKey(target);
          for (let attempt = 0; attempt < MAX_SELECT_ATTEMPTS; attempt++) {
            const commandId = CommandId.make(attempt === 0 ? base : base + ":retry:" + attempt);
            const status = yield* threads.receiptStatus(commandId);
            if (status === "accepted") return { _tag: "Accepted" } as const;
            if (status === null) return { _tag: "Next", commandId } as const;
          }
          return { _tag: "GaveUp" } as const;
        });
      // A restart after our selection landed: finish that hop instead of choosing again, even
      // if its account has since run out. Only our accepted receipt counts; a model the user
      // picked by hand goes to the recovery sweep as it would without a chain.
      if (!modelSelectionsEqual(shell.modelSelection, current)) {
        const ours =
          resolved.chain.steps.some((step) =>
            modelSelectionsEqual(toSelection(step), shell.modelSelection),
          ) && (yield* attempts(shell.modelSelection))._tag === "Accepted";
        if (!ours) return false;
        yield* announce(shell.modelSelection, new Set(tried.map(stepKey)).size);
        return true;
      }
      // Steps skipped for this decision only: refused just now, or off for this project.
      const skipped = new Map<string, string>();
      for (let attempt = 0; attempt < resolved.chain.steps.length; attempt++) {
        const unavailable = yield* unavailability;
        const decision = decideNext({
          chain: resolved.chain,
          current,
          failure,
          tried,
          unavailable: (step) =>
            skipped.get(stepKey(step)) ?? unavailable(step, current.instanceId, true),
        });
        if (decision._tag === "Exhausted") {
          yield* noticeOnce(threadId, runId, resolved.id, decision.reason);
          return false;
        }
        const target = toSelection(decision.step);
        if (
          !(yield* threads.isProviderInstanceEnabledForProject({
            projectId: shell.projectId,
            instanceId: target.instanceId,
          }))
        ) {
          // Only this project turned it off; other projects may still use it.
          skipped.set(stepKey(target), "is turned off for this project");
          continue;
        }
        const next = yield* attempts(target);
        if (next._tag === "GaveUp") {
          skipped.set(stepKey(target), "was refused " + MAX_SELECT_ATTEMPTS + " times");
          continue;
        }
        const selected =
          next._tag === "Accepted" ||
          (yield* threads
            .dispatch({
              type: modelSelectionCommandType(shell.providerInstanceId, target),
              commandId: next.commandId,
              threadId,
              modelSelection: target,
            })
            .pipe(
              Effect.provideService(FallbackSelectionSource, {
                runId,
                modelSelection: current,
              }),
              Effect.as(true),
              Effect.catchCause((cause) =>
                Effect.logWarning("fleet.fallback.select-refused", { threadId, cause }).pipe(
                  Effect.as(false),
                ),
              ),
            ));
        if (!selected) {
          skipped.set(stepKey(target), "was refused");
          yield* reportFailure(target, "unavailable");
          continue;
        }
        yield* announce(target, decision.hop);
        return true;
      }
      return false;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("fleet.fallback.failed", { threadId, cause }).pipe(Effect.as(false)),
      ),
    );

  return Fallback.of({
    next,
    reportFailure,
    cooldowns: Effect.gen(function* () {
      const now = yield* nowMs;
      return [...(yield* Ref.get(cooldownState)).values()].filter(
        (entry) => Date.parse(entry.until) > now,
      );
    }),
    coversThreads: Effect.map(fleetSettings, anyThreadChain),
    continueThread,
  });
});

export const layer = Layer.effect(Fallback, make);

/** The fleet keys one goat_fallback_chain_set writes, computed from \`fleet\`. */
function chainPatch(fleet: FleetSettings, input: GoatFallbackChainSetInput) {
  const chains = { ...fleet.fallbackChains };
  if (input.chain === null) delete chains[input.id];
  else chains[input.id] = input.chain;
  const currentDefault = fleet.defaultFallbackChain ?? null;
  const defaultFallbackChain =
    input.chain === null || input.makeDefault === false
      ? currentDefault === input.id
        ? null
        : currentDefault
      : input.makeDefault === true
        ? input.id
        : currentDefault;
  return { fallbackChains: chains, defaultFallbackChain };
}

/** settingsPath of the error an authorizeAtCommit check raises when the caller lost access. */
export const CALLER_REVOKED = "fleet:caller-revoked";

export interface FallbackChainsShape {
  readonly get: Effect.Effect<GoatFallbackChainGetResult>;
  readonly set: (
    input: GoatFallbackChainSetInput,
    /** Re-checks the caller inside the settings write lock. */
    authorizeAtCommit?: Effect.Effect<void, ServerSettingsError>,
  ) => Effect.Effect<GoatFallbackChainSetResult, FallbackChainsError>;
}

export class FallbackChainsError extends Schema.TaggedError<FallbackChainsError>()(
  "FallbackChainsError",
  { message: Schema.String },
) {}

/** Settings-backed chain editing for goat_fallback_chain_get and goat_fallback_chain_set. */
export class FallbackChains extends Context.Service<FallbackChains, FallbackChainsShape>()(
  "goat/fleet/resources/Fallback/FallbackChains",
) {}

export const layerChains = Layer.effect(
  FallbackChains,
  Effect.gen(function* () {
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const registry = yield* ProviderRegistry.ProviderRegistry;
    const read = settingsService.getSettings.pipe(
      Effect.map((settings) => settings.fleet),
      Effect.orElseSucceed((): FleetSettings => ({})),
    );
    const view = (fleet: FleetSettings): GoatFallbackChainGetResult => ({
      chains: { ...fleet.fallbackChains },
      defaultFallbackChain: fleet.defaultFallbackChain ?? null,
    });
    return FallbackChains.of({
      get: Effect.map(read, view),
      set: (input, authorizeAtCommit) =>
        Effect.gen(function* () {
          const warnings: Array<string> = [];
          if (input.chain !== null) {
            const providers = yield* registry.getProviders;
            for (const step of input.chain.steps) {
              const provider = providers.find((item) => item.instanceId === step.instanceId);
              if (provider === undefined)
                return yield* new FallbackChainsError({
                  message:
                    "Provider instance " +
                    step.instanceId +
                    ` is not configured here; ${goatCallText("provider.list")} lists the instances.`,
                });
              if (
                !provider.models.some(
                  (model) => model.slug === step.model || model.aliases?.includes(step.model),
                )
              )
                warnings.push(step.instanceId + " does not list model " + step.model + ".");
            }
          }
          const saved = yield* settingsService
            .updateSettingsWith(
              (current) => Effect.succeed({ fleet: chainPatch(current.fleet, input) }),
              authorizeAtCommit,
            )
            .pipe(
              Effect.mapError(
                (error) =>
                  new FallbackChainsError({
                    message:
                      error.settingsPath === CALLER_REVOKED
                        ? "The caller lost full access before the chain was saved."
                        : "Server settings could not be saved.",
                  }),
              ),
            );
          return { ...view(saved.fleet), warnings };
        }),
    });
  }),
);
