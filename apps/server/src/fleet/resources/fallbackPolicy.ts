/**
 * Pure fallback chain rules. The Fallback service supplies cooldowns, availability and the
 * thread's runs, and turns the decision into commands.
 *
 * @module fallbackPolicy
 */
import {
  DEFAULT_FALLBACK_ON,
  type FallbackChain,
  type FallbackChainStep,
  type FallbackFailure,
  type FallbackTrigger,
  type FleetSettings,
  type ModelSelection,
} from "@goat/contracts";

type StepLike = Pick<ModelSelection, "instanceId" | "model">;

/**
 * The failure classes a chain's triggers move on. A route that refuses the model for this account
 * (a 403, a plan without it) cannot serve it however often it is retried, so `unavailable` covers
 * that `permission_error` too (#1205). Candidate selection and decideNext both read this.
 */
export const failureClassesOf = (
  triggers: ReadonlyArray<FallbackTrigger>,
): ReadonlyArray<FallbackFailure> => [
  ...new Set(
    triggers.flatMap((trigger): ReadonlyArray<FallbackFailure> =>
      trigger === "unavailable" ? ["unavailable", "permission_error"] : [trigger],
    ),
  ),
];

export const stepKey = (step: StepLike) => step.instanceId + "/" + step.model;

export const toSelection = (step: FallbackChainStep): ModelSelection => ({
  instanceId: step.instanceId,
  model: step.model,
  ...(step.options === undefined ? {} : { options: step.options }),
});

const contains = (chain: FallbackChain, selection: StepLike) =>
  chain.steps.some((step) => stepKey(step) === stepKey(selection));

/**
 * The chain an ordinary thread follows: one that opted into threads and lists the thread's
 * model, the default chain first, then by id so the choice is stable.
 */
export function ordinaryThreadChain(
  settings: FleetSettings,
  selection: StepLike,
): { readonly id: string; readonly chain: FallbackChain } | null {
  const chains = settings.fallbackChains ?? {};
  const ids = Object.keys(chains).toSorted();
  const preferred = settings.defaultFallbackChain;
  const ordered =
    preferred != null && chains[preferred] !== undefined
      ? [preferred, ...ids.filter((id) => id !== preferred)]
      : ids;
  for (const id of ordered) {
    const chain = chains[id]!;
    if (chain.scope === "goals_and_threads" && contains(chain, selection)) return { id, chain };
  }
  return null;
}

export const anyThreadChain = (settings: FleetSettings) =>
  Object.values(settings.fallbackChains ?? {}).some((chain) => chain.scope === "goals_and_threads");

export interface NextInput {
  readonly chain: FallbackChain;
  readonly current: StepLike;
  readonly failure: FallbackFailure;
  /** Selections already used for this work, the current one included or not. */
  readonly tried: ReadonlyArray<StepLike>;
  /** Why a step cannot be used now (cooldown, disabled, out of quota), or undefined. */
  readonly unavailable: (step: FallbackChainStep) => string | undefined;
}

export type NextDecision =
  | { readonly _tag: "Step"; readonly step: FallbackChainStep; readonly hop: number }
  | { readonly _tag: "Exhausted"; readonly reason: string };

/**
 * Steps after the current one come first, then earlier ones, so a chain returns to its
 * first model once that model's cooldown ends. A hop is one move away from the first model
 * this work used.
 */
export function decideNext(input: NextInput): NextDecision {
  const { chain, current } = input;
  const on = chain.on ?? DEFAULT_FALLBACK_ON;
  if (!failureClassesOf(on).includes(input.failure))
    return { _tag: "Exhausted", reason: input.failure + " is not one of this chain's triggers" };
  const tried = new Set([...input.tried.map(stepKey), stepKey(current)]);
  const hopsUsed = tried.size - 1;
  const maxHops = chain.maxHops ?? chain.steps.length - 1;
  if (hopsUsed >= maxHops) return { _tag: "Exhausted", reason: "used all " + maxHops + " hops" };
  const index = chain.steps.findIndex((step) => stepKey(step) === stepKey(current));
  const ordered =
    index === -1 ? chain.steps : [...chain.steps.slice(index + 1), ...chain.steps.slice(0, index)];
  const skipped: Array<string> = [];
  for (const step of ordered) {
    if (tried.has(stepKey(step))) continue;
    const reason = input.unavailable(step);
    if (reason !== undefined) {
      skipped.push(stepKey(step) + " " + reason);
      continue;
    }
    return { _tag: "Step", step, hop: hopsUsed + 1 };
  }
  return {
    _tag: "Exhausted",
    reason:
      skipped.length === 0
        ? "every step was already tried"
        : "no step is available (" + skipped.join(", ") + ")",
  };
}

/**
 * The selections of the failed runs at the end of a thread, newest first: the work that has
 * not succeeded since its last good turn. Read from the projection, so it survives a restart.
 */
export function failedTail(
  runs: ReadonlyArray<{
    readonly status: string;
    readonly ordinal: number;
    readonly startedAt: unknown;
    readonly modelSelection: StepLike;
  }>,
): ReadonlyArray<StepLike> {
  const tail: Array<StepLike> = [];
  for (const run of runs.toSorted((left, right) => right.ordinal - left.ordinal)) {
    if (run.status === "queued" || (run.status === "cancelled" && run.startedAt === null)) continue;
    if (run.status !== "failed") break;
    tail.push(run.modelSelection);
  }
  return tail;
}
