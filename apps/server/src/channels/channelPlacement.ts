/**
 * Where a channel task runs, chosen by remaining subscription quota and current load.
 *
 * The caller first limits candidates to ready accounts and eligible repositories, so the same
 * rule serves this machine, a named SSH host, and opt-in placement across connected hosts.
 * The scoring follows GOAT Anywhere's router (lidge-jun/goat-anywhere `web/lib/router.ts`
 * at e551966): the busiest quota window counts, an account that reports nothing counts as
 * moderately used, and every task already running on a candidate adds a fixed penalty so
 * concurrent work spreads out instead of piling onto one account or machine.
 *
 * @module channelPlacement
 */

import type { QuotaPool, ServerProviderUsageLimits } from "@goat/contracts";
import {
  appliesToModel,
  freshWindows,
  isWindowExhausted,
  verdictWindows,
  type VerdictWindow,
} from "@goat/shared/quotaVerdict";

/** Assumed use of an account that reports no quota windows. */
export const UNKNOWN_QUOTA_PERCENT = 35;
/** Added per task already running on the candidate. */
export const LOAD_PENALTY = 40;
/** Reasons are cut to this length; the chip has room for one short line. */
const PLACEMENT_REASON_CHARS = 200;

/** A numeric window or a percentless availability block; see quotaVerdict. */
export type PlacementWindow = VerdictWindow;

/** A report's windows and availability blocks, or null when it has none. */
export const usageWindows = (limits: ServerProviderUsageLimits | undefined) => {
  const windows = limits === undefined ? [] : verdictWindows(limits);
  return windows.length === 0 ? null : windows;
};

export interface PlacementCandidate<A> {
  /** Whatever the caller needs back, such as the model selection to launch with. */
  readonly value: A;
  /** The SSH alias, or null for this machine. */
  readonly host: string | null;
  readonly providerLabel: string;
  /** The configured choice; it wins ties. */
  readonly preferred: boolean;
  /** Null when the account reports no quota. */
  readonly windows: ReadonlyArray<PlacementWindow> | null;
  readonly checkedAt?: string | undefined;
  /** Tasks already running where this candidate would run. */
  readonly activeTasks: number;
  readonly model?: string | undefined;
  readonly quotaPool?: QuotaPool["providers"][number] | undefined;
  readonly accountRef?: string | undefined;
}

export interface Placement<A> {
  readonly chosen: PlacementCandidate<A>;
  /** Short, human text for the task chip. Absent when there was nothing to choose or report. */
  readonly reason: string | undefined;
}

export function placementWindows(
  candidate: PlacementCandidate<unknown>,
): ReadonlyArray<PlacementWindow> {
  const pool = candidate.quotaPool;
  const windows =
    pool === undefined
      ? (candidate.windows ?? [])
      : (candidate.accountRef === undefined
          ? pool.pooled.windows
          : (pool.accounts.find((account) => account.accountRef === candidate.accountRef)
              ?.windows ?? [])
        ).filter((window) => window.usedPercent !== undefined || window.exhausted === true);
  return windows.filter((window) => appliesToModel(window.scopeModel, candidate.model));
}

export const isExhausted = (candidate: PlacementCandidate<unknown>, now: number) =>
  placementWindows(candidate).some((window) => isWindowExhausted(window, now));

/** The busiest numeric window, rounded, or null when none is reported. */
export const busiestWindow = (candidate: PlacementCandidate<unknown>) => {
  let top: { readonly label: string; readonly usedPercent: number } | null = null;
  for (const window of placementWindows(candidate)) {
    if (window.usedPercent === undefined) continue;
    if (top === null || window.usedPercent > top.usedPercent)
      top = { label: window.label, usedPercent: window.usedPercent };
  }
  return top === null ? null : { label: top.label, usedPercent: Math.round(top.usedPercent) };
};

const score = (candidate: PlacementCandidate<unknown>) =>
  (busiestWindow(candidate)?.usedPercent ?? UNKNOWN_QUOTA_PERCENT) +
  LOAD_PENALTY * candidate.activeTasks;

const labelOf = (candidate: PlacementCandidate<unknown>) =>
  candidate.host === null
    ? candidate.providerLabel
    : candidate.host + " · " + candidate.providerLabel;

const usedText = (window: { readonly label: string; readonly usedPercent: number }) =>
  window.usedPercent + "% " + window.label.toLowerCase() + " used";

/**
 * The best candidate and why. Candidates at a quota limit are skipped while another can run;
 * when every one is at its limit the configured or least loaded one still gets the work, and
 * the reason says so. Undefined when there are no candidates.
 */
export function choosePlacement<A>(
  input: ReadonlyArray<PlacementCandidate<A>>,
  now: number,
): Placement<A> | undefined {
  const candidates = input.map((candidate) => {
    const windows = freshWindows(placementWindows(candidate), candidate.checkedAt, now);
    // Score the filtered pool reading instead of reading the original pool again.
    return { ...candidate, quotaPool: undefined, windows: windows.length ? windows : null };
  });
  if (candidates.length === 0) return undefined;
  const open = candidates.filter((candidate) => !isExhausted(candidate, now));
  const allExhausted = open.length === 0;
  const pool = allExhausted ? candidates : open;
  // Stable: equal scores keep the configured choice, then the caller's order.
  const ranked = pool
    .map((candidate, index) => ({ candidate, index }))
    .toSorted(
      (left, right) =>
        score(left.candidate) - score(right.candidate) ||
        Number(right.candidate.preferred) - Number(left.candidate.preferred) ||
        left.index - right.index,
    );
  const chosen = ranked[0]!.candidate;
  const used = busiestWindow(chosen);

  if (allExhausted) {
    return {
      chosen,
      reason: clip(
        labelOf(chosen) +
          (candidates.length === 1
            ? " · at its usage limit"
            : " · every candidate is at its usage limit"),
      ),
    };
  }
  const skipped = candidates.filter((candidate) => isExhausted(candidate, now));
  // Nothing reported and nothing moved: the requester has nothing to read.
  if (
    chosen.host === null &&
    chosen.preferred &&
    candidates.every((candidate) => placementWindows(candidate).length === 0)
  ) {
    return { chosen, reason: undefined };
  }
  if (chosen.host === null && candidates.length === 1 && used === null)
    return { chosen, reason: undefined };

  const parts = [labelOf(chosen)];
  if (used !== null) {
    const runnerUp = ranked
      .slice(1)
      .map(({ candidate }) => ({ candidate, used: busiestWindow(candidate) }))
      .filter((entry) => entry.used !== null && entry.used.usedPercent > used.usedPercent)
      .toSorted((left, right) => left.used!.usedPercent - right.used!.usedPercent)[0];
    parts.push(
      usedText(used) +
        (runnerUp === undefined
          ? ""
          : " (vs " + runnerUp.used!.usedPercent + "% on " + labelOf(runnerUp.candidate) + ")"),
    );
  } else {
    parts.push("usage not reported");
  }
  if (chosen.activeTasks === 0 && pool.some((candidate) => candidate.activeTasks > 0)) {
    parts.push("free while others work");
  }
  if (skipped.length > 0) {
    parts.push(skipped.map(labelOf).join(", ") + " at usage limit");
  }
  return { chosen, reason: clip(parts.join(" · ")) };
}

const clip = (reason: string) =>
  reason.length <= PLACEMENT_REASON_CHARS
    ? reason
    : reason.slice(0, PLACEMENT_REASON_CHARS - 1).trimEnd() + "…";
