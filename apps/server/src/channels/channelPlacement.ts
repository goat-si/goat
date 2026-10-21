/**
 * Where a channel task runs, chosen by remaining subscription quota and current load.
 *
 * A pure function so the same rule serves this machine, a named SSH host, and later a
 * repository-aware host filter (#218) that narrows the candidates before they are scored.
 * The scoring follows GOAT Anywhere's router (lidge-jun/goat-anywhere `web/lib/router.ts`
 * at e551966): the busiest quota window counts, an account that reports nothing counts as
 * moderately used, and every task already running on a candidate adds a fixed penalty so
 * concurrent work spreads out instead of piling onto one account or machine.
 *
 * @module channelPlacement
 */

import type { QuotaPool } from "@goat/contracts";

/** Assumed use of an account that reports no quota windows. */
export const UNKNOWN_QUOTA_PERCENT = 35;
/** Added per task already running on the candidate. */
export const LOAD_PENALTY = 40;
/** Reasons are cut to this length; the chip has room for one short line. */
const PLACEMENT_REASON_CHARS = 200;

export interface PlacementWindow {
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAt?: string | undefined;
  readonly scopeModel?: string | undefined;
}

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

/** A window at its limit counts until it resets; one whose reset time passed is stale. */
const exhaustedWindow = (window: PlacementWindow, now: number) => {
  if (window.usedPercent < 100) return false;
  if (window.resetsAt === undefined) return true;
  const resets = Date.parse(window.resetsAt);
  return Number.isNaN(resets) || resets > now;
};

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
        ).flatMap((window) => {
          const usedPercent = window.exhausted === true ? 100 : window.usedPercent;
          return usedPercent === undefined ? [] : [{ ...window, usedPercent }];
        });
  return windows.filter((window) => {
    if (window.scopeModel === undefined) return true;
    const model = candidate.model?.split("/").at(-1);
    if (window.scopeModel === model || window.scopeModel === candidate.model) return true;
    // OpenCodex also proves Claude family scopes; versioned models in that family share the limit.
    if (window.scopeModel.startsWith("family:")) {
      const family = window.scopeModel.slice("family:".length);
      return model === family || model?.startsWith(`claude-${family}-`) === true;
    }
    return false;
  });
}

export const isExhausted = (candidate: PlacementCandidate<unknown>, now: number) =>
  placementWindows(candidate).some((window) => exhaustedWindow(window, now));

/** The busiest window, rounded, or null when none is reported. */
export const busiestWindow = (candidate: PlacementCandidate<unknown>) => {
  const windows = placementWindows(candidate);
  if (windows.length === 0) return null;
  const top = windows.reduce((left, right) =>
    right.usedPercent > left.usedPercent ? right : left,
  );
  return { label: top.label, usedPercent: Math.round(top.usedPercent) };
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
  candidates: ReadonlyArray<PlacementCandidate<A>>,
  now: number,
): Placement<A> | undefined {
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
    chosen.preferred &&
    candidates.every((candidate) => placementWindows(candidate).length === 0)
  ) {
    return { chosen, reason: undefined };
  }
  if (candidates.length === 1 && used === null) return { chosen, reason: undefined };

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
