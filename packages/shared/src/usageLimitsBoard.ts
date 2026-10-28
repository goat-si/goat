import type { ServerProvider, UsageLimitSourceSnapshots } from "@goat/contracts";

import { freshWindows, isWindowExhausted, type VerdictWindow } from "./quotaVerdict.ts";
import {
  collectLimitAccounts,
  collectLimitPools,
  displayLimitWindows,
  formatDuration,
  limitsNotice,
  localLimits,
  providersWithLimits,
  routedThroughOpenCodex,
  sourceAccountName,
  type LimitAccount,
  type LimitOrigin,
  type LimitPoolWindow,
  type LimitPresentations,
} from "./usageLimits.ts";
import { availabilityText, collectOpenCodexPools } from "./usageLimitsOpenCodex.ts";

/** Usage › Limits as people read it: per provider, accounts grouped by where GOAT learned of them. */
export type LimitRowStatus = "ready" | "blocked" | "unknown" | "paused" | "reauth";

export interface LimitBoardRow {
  readonly key: string;
  readonly driver: ServerProvider["driver"];
  readonly name: string | null;
  readonly email: string | undefined;
  readonly plan: string | undefined;
  /** Null for an account that reports no reading, which never joins pooled math. */
  readonly account: LimitAccount | null;
  readonly status: LimitRowStatus;
  /** When every exhausted window has reset; null when a reset time is unknown. */
  readonly releaseAt: number | null;
  readonly note: string | undefined;
  readonly alsoVia: readonly string[];
  /** Counts toward the provider's verdict. */
  readonly active: boolean;
}

export interface LimitBoardGroup {
  readonly key: string;
  readonly kind: LimitOrigin["kind"];
  readonly title: string;
  readonly detail: string | undefined;
  /** Why GOAT could not read this pool; the group has no rows then. */
  readonly unreadable: string | undefined;
  /** Pool-wide blocks for this pool only. */
  readonly blocks: readonly string[];
  readonly windows: readonly LimitPoolWindow[];
  readonly rows: readonly LimitBoardRow[];
}

export interface LimitBoardSection {
  readonly driver: ServerProvider["driver"];
  readonly verdict: { readonly tone: "ready" | "blocked" | "unknown"; readonly text: string };
  readonly groups: readonly LimitBoardGroup[];
}

const ORIGIN_RANK: Record<LimitOrigin["kind"], number> = { pool: 0, login: 1, proxy: 2 };
const SHOWN_IN: Record<LimitOrigin["kind"], number> = { login: 0, pool: 1, proxy: 2 };
const STATUS_RANK: Record<LimitRowStatus, number> = {
  ready: 0,
  blocked: 1,
  unknown: 2,
  paused: 3,
  reauth: 4,
};

/** OpenCodex Home ids are `home_<hex>`; six hex digits tell Homes apart without the full id. */
export function homeLabel(homeId: string | undefined, sourceLabel: string): string {
  if (homeId === undefined) return sourceLabel.replace(/^via /, "");
  const hex = /^home_([0-9a-f]{6})/i.exec(homeId)?.[1];
  return `Home ${hex ?? homeId}`;
}

function originName(origin: LimitOrigin): string {
  if (origin.kind === "login") return "a direct login";
  if (origin.kind === "pool") return `OpenCodex pool ${homeLabel(origin.homeId, origin.label)}`;
  return origin.label;
}

function primaryOrigin(origins: readonly LimitOrigin[]): LimitOrigin {
  return (
    origins.toSorted((left, right) => SHOWN_IN[left.kind] - SHOWN_IN[right.kind])[0] ?? {
      kind: "login",
    }
  );
}

function groupKey(origin: LimitOrigin, account: LimitAccount | null, environments: string[]) {
  if (origin.kind === "pool") return `pool:${origin.homeId ?? origin.label}`;
  if (origin.kind === "proxy") return `proxy:${origin.label}`;
  void account;
  return `login:${environments.toSorted().join("\u0000")}`;
}

/** One time policy for every verdict: stale and passed readings drop out; exhaustion wins. */
export function limitRowStatus(
  account: Pick<LimitAccount, "limits" | "state">,
  now: number,
): Pick<LimitBoardRow, "status" | "releaseAt" | "note"> {
  if (account.state === "paused") return { status: "paused", releaseAt: null, note: undefined };
  if (account.state === "reauth") return { status: "reauth", releaseAt: null, note: undefined };
  const readings = freshWindows<VerdictWindow>(
    [...account.limits.windows, ...(account.limits.availability ?? [])],
    account.limits.checkedAt,
    now,
  );
  const gates = readings.filter((window) => window.scopeModel === undefined);
  const spent = gates.filter((window) => isWindowExhausted(window, now));
  const scoped = readings
    .filter((window) => window.scopeModel !== undefined && isWindowExhausted(window, now))
    .map((window) => (window.scopeModel ?? "").replace(/^family:/, ""));
  const note = scoped.length > 0 ? `${scoped.join(", ")} blocked` : undefined;
  if (spent.length > 0) {
    const resets = spent.map((window) =>
      window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt),
    );
    const known = resets.every(Number.isFinite);
    return { status: "blocked", releaseAt: known ? Math.max(...resets) : null, note };
  }
  if (gates.length === 0)
    return { status: "unknown", releaseAt: null, note: note ?? "No current reading" };
  return { status: "ready", releaseAt: null, note };
}

/** The tightest quota left among the readings that decide the status. */
function headroom(row: LimitBoardRow, now: number) {
  const limits = row.account?.limits;
  if (limits === undefined) return 0;
  return Math.min(
    ...freshWindows(limits.windows, limits.checkedAt, now)
      .filter((window) => window.scopeModel === undefined)
      .map((window) => 100 - window.usedPercent),
  );
}

const compareRows = (now: number) => (left: LimitBoardRow, right: LimitBoardRow) =>
  STATUS_RANK[left.status] - STATUS_RANK[right.status] ||
  (left.status === "ready" ? headroom(right, now) - headroom(left, now) : 0) ||
  (left.status === "blocked"
    ? (left.releaseAt ?? Number.POSITIVE_INFINITY) - (right.releaseAt ?? Number.POSITIVE_INFINITY)
    : 0) ||
  (left.name ?? left.email ?? left.key).localeCompare(right.name ?? right.email ?? right.key);

export function limitVerdict(rows: readonly LimitBoardRow[], now: number) {
  const active = rows.filter((row) => row.active);
  const count = (status: LimitRowStatus) => active.filter((row) => row.status === status).length;
  const excluded = rows.filter((row) => row.status === "paused" || row.status === "reauth").length;
  const suffix = excluded > 0 ? ` · ${excluded} paused or signed out` : "";
  const ready = count("ready");
  const blocked = count("blocked");
  const unknown = count("unknown");
  if (active.length === 0) return { tone: "unknown" as const, text: `No active accounts${suffix}` };
  if (ready > 0)
    return { tone: "ready" as const, text: `${ready} of ${active.length} ready${suffix}` };
  const releases = active.flatMap((row) =>
    row.status === "blocked" && row.releaseAt !== null ? [row.releaseAt] : [],
  );
  const parts =
    blocked === active.length
      ? ["All active accounts blocked"]
      : [blocked > 0 ? `${blocked} blocked` : "", unknown > 0 ? `${unknown} no reading` : ""];
  const next =
    releases.length > 0
      ? ` · next frees in ${formatDuration(Math.min(...releases) - now)}`
      : blocked > 0
        ? " · release time unknown"
        : "";
  return {
    tone: blocked > 0 ? ("blocked" as const) : ("unknown" as const),
    text: parts.filter(Boolean).join(" · ") + next + suffix,
  };
}

interface Pending {
  readonly origin: LimitOrigin;
  readonly environments: string[];
  readonly row: LimitBoardRow;
}

function readingRow(account: LimitAccount, now: number): Pending {
  const origins = account.origins ?? [{ kind: "login" as const }];
  const origin = primaryOrigin(origins);
  return {
    origin,
    environments: account.environments.map((environment) => environment.label),
    row: {
      key: account.key,
      driver: account.driver,
      name: account.poolName ?? account.displayName,
      email: account.email,
      plan: account.plan,
      account,
      ...limitRowStatus(account, now),
      alsoVia: origins.filter((other) => other !== origin).map(originName),
      active: account.aggregated !== false,
    },
  };
}

function noReadingRow(
  base: Omit<LimitBoardRow, "account" | "status" | "releaseAt" | "alsoVia" | "active" | "note">,
  state: LimitAccount["state"],
  note: string,
): LimitBoardRow {
  const status = state === "paused" ? "paused" : state === "reauth" ? "reauth" : "unknown";
  return {
    ...base,
    account: null,
    status,
    releaseAt: null,
    note: status === "unknown" ? note : undefined,
    alsoVia: [],
    active: status === "unknown",
  };
}

function newestSources(presentations: LimitPresentations) {
  const newest = new Map<string, UsageLimitSourceSnapshots[number]>();
  for (const presentation of presentations.values()) {
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      if (source.homeId === undefined) continue;
      const previous = newest.get(source.homeId);
      if (previous === undefined || Date.parse(source.checkedAt) > Date.parse(previous.checkedAt))
        newest.set(source.homeId, source);
    }
  }
  return newest;
}

/** Rows and pool states collectLimitAccounts leaves out because they carry no reading. */
function withoutReadings(presentations: LimitPresentations, shown: readonly LimitAccount[]) {
  const pending: Pending[] = [];
  const unreadable = new Map<ServerProvider["driver"], { messages: Set<string>; via: string[] }>();
  const known = new Set(
    shown.flatMap((account) =>
      account.email ? [`${account.driver}:${account.email.trim().toLowerCase()}`] : [],
    ),
  );
  const seen = (driver: string, email: string | undefined) =>
    email !== undefined && known.has(`${driver}:${email.trim().toLowerCase()}`);
  const login = (environmentLabel: string, provider: ServerProvider, key: string, note: string) => {
    if (seen(provider.driver, provider.auth.email)) return;
    pending.push({
      origin: { kind: "login" },
      environments: [environmentLabel],
      row: noReadingRow(
        {
          key,
          driver: provider.driver,
          name: provider.displayName?.trim() || null,
          email: provider.auth.email,
          plan: provider.auth.label,
        },
        undefined,
        note,
      ),
    });
  };
  const newest = newestSources(presentations);
  for (const [environmentId, presentation] of presentations) {
    const label = presentation.entry.target.label;
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      const limits = provider.usageLimits;
      if (limits === undefined || limits.unavailable?.reason === "unsupported") continue;
      if (routedThroughOpenCodex(limits)) {
        if (limits.quotaPool === undefined) {
          const entry = unreadable.get(provider.driver) ?? { messages: new Set(), via: [] };
          entry.messages.add(limitsNotice(limits) ?? "The OpenCodex pool could not be read.");
          entry.via.push(`${provider.displayName?.trim() || provider.instanceId} on ${label}`);
          unreadable.set(provider.driver, entry);
        }
        const own = localLimits(limits);
        const notice = own === undefined ? null : limitsNotice(own.limits);
        if (notice !== null)
          login(label, provider, `${environmentId}:${provider.instanceId}:login`, notice);
        continue;
      }
      const notice = limitsNotice(limits);
      if (notice !== null)
        login(label, provider, `${environmentId}:${provider.instanceId}`, notice);
    }
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      if (source.homeId !== undefined && newest.get(source.homeId) !== source) continue;
      for (const account of source.accounts) {
        const notice = limitsNotice(account.usageLimits);
        if (notice === null || seen(account.driver, account.email)) continue;
        pending.push({
          origin:
            source.kind === "opencodex"
              ? { kind: "pool", homeId: source.homeId, label: source.label }
              : { kind: "proxy", label: source.label },
          environments: [],
          row: noReadingRow(
            {
              key: `${source.id}:${account.id}`,
              driver: account.driver,
              name: sourceAccountName(source.kind, account),
              email: account.email,
              plan: account.plan,
            },
            account.state,
            notice,
          ),
        });
      }
    }
  }
  return { pending, unreadable };
}

function sourceNotices(presentations: LimitPresentations): string[] {
  const notices: string[] = [];
  for (const presentation of presentations.values()) {
    const prefix = presentations.size > 1 ? `${presentation.entry.target.label} · ` : "";
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      if (source.error) notices.push(`${prefix}${source.label}: ${source.error}`);
      else if (source.accounts.length === 0)
        notices.push(`${prefix}${source.label}: No accounts reported.`);
    }
  }
  return notices;
}

function groupWindows(accounts: readonly LimitAccount[], now: number) {
  // A group's own accounts set its columns; a routed login is the whole of its group.
  const counted = accounts.map((account) =>
    account.aggregated === false && account.state !== "paused" && account.state !== "reauth"
      ? { ...account, aggregated: true }
      : account,
  );
  const pool = collectLimitPools(counted, now)[0];
  return pool === undefined ? [] : displayLimitWindows(pool);
}

/** The whole Limits view; notices are only what no group or row already shows. */
export function limitBoard(presentations: LimitPresentations, now: number) {
  const accounts = collectLimitAccounts(presentations);
  const { pending, unreadable } = withoutReadings(presentations, accounts);
  const all = [...accounts.map((account) => readingRow(account, now)), ...pending];
  const lines = collectOpenCodexPools(presentations);
  const drivers = [
    ...new Set([
      ...all.map((entry) => entry.row.driver),
      ...lines.map((line) => line.driver),
      ...unreadable.keys(),
    ]),
  ];
  const sections = drivers.map((driver): LimitBoardSection => {
    const groups = new Map<
      string,
      { origin: LimitOrigin; environments: string[]; rows: LimitBoardRow[] }
    >();
    for (const entry of all.filter((candidate) => candidate.row.driver === driver)) {
      const key = groupKey(entry.origin, entry.row.account, entry.environments);
      const group = groups.get(key) ?? {
        origin: entry.origin,
        environments: entry.environments,
        rows: [],
      };
      group.rows.push(entry.row);
      groups.set(key, group);
    }
    for (const line of lines.filter((candidate) => candidate.driver === driver)) {
      const key = `pool:${line.homeId}`;
      if (!groups.has(key))
        groups.set(key, {
          origin: { kind: "pool", homeId: line.homeId, label: "" },
          environments: [],
          rows: [],
        });
    }
    const built = [...groups].map(([key, group]): LimitBoardGroup => {
      const { origin } = group;
      const line =
        origin.kind === "pool"
          ? lines.find(
              (candidate) => candidate.driver === driver && candidate.homeId === origin.homeId,
            )
          : undefined;
      const excluded = line?.accounts.excluded;
      return {
        key,
        kind: origin.kind,
        title:
          origin.kind === "pool"
            ? "OpenCodex pool"
            : origin.kind === "proxy"
              ? origin.label
              : group.environments.length > 0
                ? `Signed in on ${group.environments.join(", ")}`
                : "Signed in",
        detail:
          origin.kind === "pool"
            ? [
                homeLabel(origin.homeId, origin.label),
                line
                  ? `${line.accounts.available} of ${line.accounts.total} available` +
                    (excluded ? ` · ${excluded} paused or signed out` : "")
                  : "",
              ]
                .filter(Boolean)
                .join(" · ")
            : origin.kind === "proxy"
              ? "CLI Proxy"
              : undefined,
        unreadable: undefined,
        blocks: line
          ? freshWindows(line.availability, line.checkedAt, now)
              .filter((block) => block.exhausted)
              .map((block) => availabilityText(block, now))
          : [],
        windows: groupWindows(
          group.rows.flatMap((row) => (row.account ? [row.account] : [])),
          now,
        ),
        rows: group.rows.toSorted(compareRows(now)),
      };
    });
    const missing = unreadable.get(driver);
    if (missing)
      built.push({
        key: `unreadable:${driver}`,
        kind: "pool",
        title: "OpenCodex pool",
        detail: `Routed: ${missing.via.join(", ")}`,
        unreadable: [...missing.messages].join(" "),
        blocks: [],
        windows: [],
        rows: [],
      });
    const ordered = built.toSorted(
      (left, right) =>
        ORIGIN_RANK[left.kind] - ORIGIN_RANK[right.kind] || left.title.localeCompare(right.title),
    );
    return {
      driver,
      verdict: limitVerdict(
        ordered.flatMap((group) => group.rows),
        now,
      ),
      groups: ordered,
    };
  });
  return { sections, notices: sourceNotices(presentations) };
}
