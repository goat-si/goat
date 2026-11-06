import type {
  PullRequestState,
  PullRequestSummary,
  PullRequestAction,
  PullRequestListEntry,
  PullRequestListState,
} from "@goat/contracts";
import { isStalePullRequestReply } from "@goat/client-runtime/pull-request-reply";

export interface PullRequestListOverride {
  readonly state: PullRequestState;
  readonly isDraft?: boolean;
  readonly updatedAt: string;
  readonly token: number;
  readonly at: number;
  /** Set when the host reported this state, so a newer row can outrank it. */
  readonly fromReply?: true;
  readonly observedAt?: number;
}

export function pullRequestOverrideAfterAction(
  entry: Pick<PullRequestListEntry, "state" | "isDraft">,
  action: PullRequestAction,
  now: Date,
  token: number,
  reply?: PullRequestSummary,
): PullRequestListOverride | null {
  if (reply !== undefined) {
    const { state, isDraft, updatedAt, observedAt } = reply;
    return {
      state,
      ...(isDraft === undefined ? {} : { isDraft }),
      updatedAt,
      ...(observedAt === undefined ? {} : { observedAt }),
      fromReply: true,
      token,
      at: now.getTime(),
    };
  }
  const stamp = { updatedAt: now.toISOString(), token, at: now.getTime() };
  switch (action) {
    case "close":
      return { state: "closed", ...stamp };
    case "reopen":
      return { state: "open", ...stamp };
    case "merge":
      return { state: "merged", ...stamp };
    case "draft":
      return { state: entry.state, isDraft: true, ...stamp };
    case "ready":
      return { state: entry.state, isDraft: false, ...stamp };
    default:
      return null;
  }
}

export function applyPullRequestOverrides<Entry extends PullRequestListEntry>(
  entries: ReadonlyArray<Entry>,
  overrides: ReadonlyMap<string, PullRequestListOverride>,
  keyOf: (entry: Entry) => string,
  state: PullRequestListState,
): ReadonlyArray<Entry> {
  if (overrides.size === 0 && state === "all") return entries;
  const out: Entry[] = [];
  for (const entry of entries) {
    const held = overrides.get(keyOf(entry));
    const override =
      held?.fromReply === true && isStalePullRequestReply(entry, held) ? undefined : held;
    if (state !== "all" && (override?.state ?? entry.state) !== state) continue;
    out.push(override === undefined ? entry : { ...entry, ...override });
  }
  return overrides.size === 0 && out.length === entries.length ? entries : out;
}

export function reusePullRequestEntries<Entry extends PullRequestListEntry>(
  previous: ReadonlyArray<Entry>,
  next: ReadonlyArray<Entry>,
  keyOf: (entry: Entry) => string,
): ReadonlyArray<Entry> {
  if (previous.length === 0) return next;
  const held = new Map(previous.map((entry) => [keyOf(entry), entry]));
  let reused = 0;
  const out = next.map((entry) => {
    const before = held.get(keyOf(entry));
    if (before !== undefined && JSON.stringify(before) === JSON.stringify(entry)) {
      reused += 1;
      return before;
    }
    return entry;
  });
  return reused === next.length &&
    previous.length === next.length &&
    previous.every((entry, index) => {
      const candidate = next[index];
      return candidate !== undefined && keyOf(entry) === keyOf(candidate);
    })
    ? previous
    : out;
}

const PULL_REQUEST_OVERRIDE_TRUST_MS = 60_000;

/** Retire overrides only when returned rows agree; partial-feed absence proves nothing. */
export function settlePullRequestOverrides<Entry extends PullRequestListEntry>(
  overrides: ReadonlyMap<string, PullRequestListOverride>,
  answered: ReadonlyArray<Entry>,
  keyOf: (entry: Entry) => string,
  now: number,
): ReadonlyMap<string, PullRequestListOverride> {
  if (overrides.size === 0) return overrides;
  const byKey = new Map(answered.map((entry) => [keyOf(entry), entry]));
  const kept = new Map<string, PullRequestListOverride>();
  for (const [key, override] of overrides) {
    const row = byKey.get(key);
    if (row === undefined) {
      kept.set(key, override);
      continue;
    }
    const agrees =
      row.state === override.state &&
      (override.isDraft === undefined || row.isDraft === override.isDraft);
    const outranked = now - override.at > PULL_REQUEST_OVERRIDE_TRUST_MS;
    if (!agrees && !outranked) kept.set(key, override);
  }
  return kept.size === overrides.size ? overrides : kept;
}
