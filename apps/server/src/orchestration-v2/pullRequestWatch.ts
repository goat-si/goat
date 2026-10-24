import type {
  OrchestrationV2Notification,
  PullRequestCheck,
  PullRequestComment,
  PullRequestDetail,
  PullRequestWatchPolicy,
  PullRequestWatchWakeMode,
  ThreadPullRequestWatch,
} from "@goat/contracts";
import { goatCallText } from "@goat/contracts/agentSurface/callText";

/**
 * Wakes in a row that bring only comments. Check, conflict, or push news resets the count, so
 * this only stops a chatty bot looping an agent that is replying to it.
 */
export const PULL_REQUEST_WATCH_WAKE_LIMIT = 10;
const LISTED_ITEMS = 10;
const SNIPPET_LENGTH = 200;
/** Failed checks a held line names before it counts the rest. */
const HELD_CHECK_NAMES = 5;
const DAY_MS = 24 * 60 * 60_000;

export type PullRequestWatchChange =
  | { readonly kind: "checks-failed"; readonly failed: ReadonlyArray<PullRequestCheck> }
  | { readonly kind: "checks-passed"; readonly count: number; readonly required: boolean }
  | { readonly kind: "remarks"; readonly remarks: ReadonlyArray<PullRequestComment> }
  | { readonly kind: "conflicting" };

export interface PullRequestWatchReport {
  /** What wakes the agent now. Empty means no wake. */
  readonly changes: ReadonlyArray<PullRequestWatchChange>;
  /** What the policy keeps as context: recorded on the thread, told with the next wake. */
  readonly held: ReadonlyArray<PullRequestWatchChange>;
  readonly next: ThreadPullRequestWatch;
  readonly exhausted: boolean;
}

/** What the policy needs besides the pull request: when the thread was last active, and now. */
export interface PullRequestWatchContext {
  readonly policy: PullRequestWatchPolicy;
  /** Epoch ms of the thread's last activity. Recorded watch progress does not move it. */
  readonly threadActiveAt: number;
  readonly now: number;
}

// "action-required" is a finished check that needs someone, so the agent hears about it.
const isFailedCheck = (check: PullRequestCheck) =>
  check.status === "failure" || check.status === "cancelled" || check.status === "action-required";

const botLogin = (login: string) => login.toLowerCase().replace(/\[bot\]$/, "");

/**
 * Bots follow `botRemarks` unless allowed, so a deploy preview or coverage comment does not
 * spend a turn. Hosts mark bots with `isBot`; GitHub app logins also end in "[bot]".
 */
const remarkMode = (remark: PullRequestComment, policy: PullRequestWatchPolicy) => {
  const login = remark.author?.login;
  if (login === undefined) return policy.humanRemarks;
  const bot = remark.author?.isBot === true || login.toLowerCase().endsWith("[bot]");
  if (!bot) return policy.humanRemarks;
  const allowed = policy.allowedBotLogins.some((entry) => botLogin(entry) === botLogin(login));
  return allowed ? policy.humanRemarks : policy.botRemarks;
};

/**
 * The policy sorts each change: `react` wakes, `keep_as_context` is held, `ignore` is
 * dropped. Every change still moves the watch forward, so a held or ignored one is never
 * reported again. A conflict on a thread idle past `conflictMaxIdleDays` is dropped.
 */
export function evaluatePullRequestWatch(
  watch: ThreadPullRequestWatch,
  detail: Pick<PullRequestDetail, "headSha" | "checks" | "mergeability" | "viewer" | "author">,
  remarks: ReadonlyArray<PullRequestComment> | null,
  context: PullRequestWatchContext,
): PullRequestWatchReport {
  const { policy } = context;
  const changes: Array<PullRequestWatchChange> = [];
  const held: Array<PullRequestWatchChange> = [];
  const sort = (change: PullRequestWatchChange, mode: PullRequestWatchWakeMode) => {
    if (mode === "react") changes.push(change);
    else if (mode === "keep_as_context") held.push(change);
  };
  const headSha = detail.headSha ?? null;
  const headMoved = headSha !== watch.headSha;

  // An empty list keeps the last state: a host can answer with one when its check read fails.
  let failedChecks = headMoved ? [] : watch.failedChecks;
  let passed = headMoved ? false : watch.passed;
  let passedChecks = headMoved ? [] : watch.passedChecks;
  if (detail.checks.length > 0) {
    const failed = detail.checks.filter(isFailedCheck);
    const newlyFailed = failed.filter((check) => !failedChecks.includes(check.name));
    if (newlyFailed.length > 0) {
      sort({ kind: "checks-failed", failed: newlyFailed }, policy.checksFailed);
    }
    failedChecks = failed.map((check) => check.name);

    const required = detail.checks.filter((check) => check.required === true);
    const gate = required.length > 0 ? required : detail.checks;
    const passedNow = gate.every((check) => check.status !== "pending" && !isFailedCheck(check));
    const gateNames = gate.map((check) => check.name);
    const told = passed && passedChecks.length === 0 ? gateNames : passedChecks;
    // A required job created and finished between two passes is never seen pending. Without
    // required checks, any check counts, and advisory bots keep adding passed ones: no wake.
    const gateGrew = required.length > 0 && gateNames.some((name) => !told.includes(name));
    if (passedNow && (!passed || gateGrew)) {
      sort(
        { kind: "checks-passed", count: gate.length, required: required.length > 0 },
        policy.checksPassed,
      );
    }
    passed = passedNow;
    passedChecks = passedNow ? gateNames : [];
  }

  const own = (detail.viewer ?? detail.author?.login)?.toLowerCase();
  const through = Date.parse(watch.remarksThrough);
  const activeAt = (remark: PullRequestComment) => remark.editedAt ?? remark.createdAt;
  // GitHub times are per second, so remarks at the boundary time are told apart by ID.
  const fresh = (remarks ?? []).filter((remark) => {
    const at = Date.parse(activeAt(remark));
    return (
      (at > through || (at === through && !watch.remarkIds.includes(remark.id))) &&
      remark.author?.login.toLowerCase() !== own
    );
  });
  const byMode = (mode: PullRequestWatchWakeMode) =>
    fresh.filter((remark) => remarkMode(remark, policy) === mode);
  for (const mode of ["react", "keep_as_context"] as const) {
    const told = byMode(mode);
    if (told.length > 0) sort({ kind: "remarks", remarks: told }, mode);
  }
  const latest = Math.max(through, ...fresh.map((remark) => Date.parse(activeAt(remark))));
  const atLatest = fresh.filter((remark) => Date.parse(activeAt(remark)) === latest);
  const remarksThrough = latest === through ? watch.remarksThrough : activeAt(atLatest[0]!);
  const remarkIds = [
    ...(latest === through ? watch.remarkIds : []),
    ...atLatest.map((remark) => remark.id),
  ];

  if (detail.mergeability === "conflicting" && !watch.conflicting) {
    // A base push can conflict every open pull request; a thread nobody touched for days stays
    // asleep. The watch still records the conflict, so it is not reported later either.
    const idle =
      policy.conflictMaxIdleDays !== null &&
      context.now - context.threadActiveAt > policy.conflictMaxIdleDays * DAY_MS;
    sort({ kind: "conflicting" }, idle ? "ignore" : policy.conflicts);
  }
  // "unknown" is GitHub still computing after a push; only a clean answer clears a conflict.
  const conflicting =
    detail.mergeability === "unknown" ? watch.conflicting : detail.mergeability === "conflicting";

  const commentsOnly = changes.length > 0 && changes.every((change) => change.kind === "remarks");
  const progress = headMoved || [...changes, ...held].some((change) => change.kind !== "remarks");
  const wakes = (progress ? 0 : watch.wakes) + (commentsOnly ? 1 : 0);
  return {
    changes,
    held,
    next: {
      startedAt: watch.startedAt,
      headSha,
      failedChecks,
      passed,
      passedChecks,
      remarksThrough,
      remarkIds,
      conflicting,
      wakes,
      ...(watch.automatic === true ? { automatic: true } : {}),
    },
    exhausted: commentsOnly && wakes >= PULL_REQUEST_WATCH_WAKE_LIMIT,
  };
}

function snippet(body: string): string {
  const text = body
    .replaceAll(/<!--[\s\S]*?-->/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  return text.length <= SNIPPET_LENGTH ? text : `${text.slice(0, SNIPPET_LENGTH - 3)}...`;
}

function listed<T>(items: ReadonlyArray<T>, line: (item: T) => string): Array<string> {
  const lines = items.slice(0, LISTED_ITEMS).map(line);
  if (items.length > LISTED_ITEMS) lines.push(`  - and ${items.length - LISTED_ITEMS} more`);
  return lines;
}

function changeLines(
  change: PullRequestWatchChange,
  context: { readonly baseBranch: string; readonly commit: string },
): Array<string> {
  switch (change.kind) {
    case "checks-failed":
      return [
        `- Checks failed${context.commit}:`,
        ...listed(
          change.failed,
          (check) =>
            `  - ${check.name}${check.status === "failure" ? "" : ` (${check.status})`}${check.url ? ` ${check.url}` : ""}`,
        ),
      ];
    case "checks-passed":
      return [
        `- All ${change.count} ${change.required ? "required " : ""}${change.count === 1 ? "check" : "checks"} passed${context.commit}.`,
      ];
    case "remarks":
      return [
        `- ${change.remarks.length} new ${change.remarks.length === 1 ? "comment" : "comments"}:`,
        ...listed(change.remarks, (remark) => {
          const where = remark.path === null ? "" : ` on ${remark.path}`;
          const body = snippet(remark.body);
          const said = body.length === 0 ? (remark.reviewState ?? "reviewed") : `"${body}"`;
          return `  - ${remark.author?.login ?? "someone"}${where}: ${said}${remark.url ? ` ${remark.url}` : ""}`;
        }),
      ];
    case "conflicting":
      return [`- The branch now conflicts with ${context.baseBranch}.`];
  }
}

const SUMMARY: Record<PullRequestWatchChange["kind"], string> = {
  "checks-failed": "checks failed",
  "checks-passed": "checks passed",
  remarks: "new comments",
  conflicting: "merge conflict",
};

/**
 * What a watch keeps as context is one fragment per kind, each the latest state of that kind:
 * a newer check result replaces the older one, and comments add up to a count with the latest
 * quoted. The kind is read from the words each fragment starts with, written only here.
 */
function heldFragment(
  change: PullRequestWatchChange,
  context: { readonly baseBranch: string; readonly commit: string },
): string {
  switch (change.kind) {
    case "checks-failed": {
      const names = change.failed.slice(0, HELD_CHECK_NAMES).map((check) => check.name);
      const more = change.failed.length - names.length;
      return `checks failed${context.commit}: ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
    }
    case "checks-passed":
      return `all ${change.count} ${change.required ? "required " : ""}${change.count === 1 ? "check" : "checks"} passed${context.commit}`;
    case "remarks": {
      const latest = change.remarks.at(-1);
      const where = latest?.path == null ? "" : ` on ${latest.path}`;
      const body = snippet(latest?.body ?? "");
      const said = body.length === 0 ? (latest?.reviewState ?? "reviewed") : `"${body}"`;
      return `${commentCount(change.remarks.length)}, latest from ${latest?.author?.login ?? "someone"}${where}: ${said}${latest?.url ? ` ${latest.url}` : ""}`;
    }
    case "conflicting":
      return `conflicts with ${context.baseBranch}`;
  }
}

const commentCount = (count: number) => `${count} new ${count === 1 ? "comment" : "comments"}`;

const HELD_KINDS = [
  ["checks", /^(checks failed|all \d+ (required )?checks? passed)/],
  ["conflict", /^conflicts with /],
  ["comments", /^\d+ new comments?[,:]/],
] as const;

const heldKind = (fragment: string) =>
  HELD_KINDS.find(([, pattern]) => pattern.test(fragment))?.[0];

/** Watches kept before #1055 stored bulleted lines; each bullet with its items is one fragment. */
function fromBullets(entries: ReadonlyArray<string>): ReadonlyArray<string> {
  const fragments: Array<string> = [];
  for (const entry of entries) {
    const last = fragments.at(-1);
    if (entry.startsWith("  - ") && last !== undefined) {
      fragments[fragments.length - 1] =
        `${last}${last.endsWith(":") ? " " : ", "}${entry.slice(4)}`;
    } else if (entry.startsWith("- ")) {
      const text = entry
        .slice(2)
        .replace(/\.$/, "")
        .replace(/^The branch now /, "");
      fragments.push(text.charAt(0).toLowerCase() + text.slice(1));
    } else fragments.push(entry);
  }
  return fragments;
}

/** Folds newly kept fragments into the ones not told yet, keeping one per kind. */
export function mergeHeldContext(
  existing: ReadonlyArray<string> = [],
  incoming: ReadonlyArray<string> = [],
): ReadonlyArray<string> {
  let merged: Array<string> = [];
  for (const fragment of [...fromBullets(existing), ...fromBullets(incoming)]) {
    const kind = heldKind(fragment);
    const previous = kind === undefined ? undefined : merged.find((f) => heldKind(f) === kind);
    merged = merged.filter((f) => f !== previous);
    if (kind !== "comments" || previous === undefined) merged.push(fragment);
    else {
      const count = Number.parseInt(previous, 10) + Number.parseInt(fragment, 10);
      merged.push(commentCount(count) + fragment.replace(/^\d+ new comments?/, ""));
    }
  }
  return merged;
}

/**
 * Drops kept fragments the pull request has since moved past: a conflict once it merges cleanly,
 * and check results once a push replaced the head they ran on.
 */
export function settleHeldContext(
  heldContext: ReadonlyArray<string> | undefined,
  state: Pick<ThreadPullRequestWatch, "conflicting" | "failedChecks" | "passed"> & {
    readonly headMoved: boolean;
  },
): ReadonlyArray<string> {
  return mergeHeldContext(heldContext).filter((fragment) => {
    switch (heldKind(fragment)) {
      case "conflict":
        return state.conflicting;
      case "checks":
        // Failures that cleared, or a pass a rerun or a new failure undid, no longer hold.
        return (
          !state.headMoved &&
          (fragment.startsWith("checks failed") ? state.failedChecks.length > 0 : state.passed)
        );
      default:
        return true;
    }
  });
}

/** The one line a digest carries for a pull request's kept context. */
export function heldContextLine(
  link: { readonly number: number; readonly url: string },
  heldContext: ReadonlyArray<string>,
): string {
  return `Pull request #${link.number} (${link.url}), kept as context: ${heldContext.join("; ")}`;
}

/** Adds what a watch kept as context to the message it ends with, so the ending loses none. */
export function withHeldContext(
  text: string,
  heldContext: ReadonlyArray<string> | undefined,
): string {
  return heldContext === undefined || heldContext.length === 0
    ? text
    : `${text}\n\nAlso kept as context without waking you: ${heldContext.join("; ")}`;
}

function pullRequestWatchMessage(input: {
  readonly number: number;
  readonly url: string;
  readonly baseBranch: string;
  readonly headSha: string | null;
  readonly report: PullRequestWatchReport;
}): PullRequestWatchWake {
  const { changes, exhausted } = input.report;
  const context = {
    baseBranch: input.baseBranch,
    commit: input.headSha === null ? "" : ` on ${input.headSha.slice(0, 7)}`,
  };
  const text = [
    `Update on pull request #${input.number} (${input.url}), which GOAT is watching for you:`,
    ...changes.flatMap((change) => changeLines(change, context)),
    "",
    exhausted
      ? `GOAT stopped watching after ${PULL_REQUEST_WATCH_WAKE_LIMIT} comment-only updates in a row. Call ${goatCallText("pull_request.watch")} to watch it again.`
      : `Look into each item and act on it as your task requires. GOAT keeps watching and wakes you on the next change, so end your turn when you are done. When you hand the work back to the user, call ${goatCallText("pull_request.unwatch")} first so the thread returns to their inbox.`,
  ].join("\n");
  const failed = changes.some(
    (change) => change.kind === "checks-failed" || change.kind === "conflicting",
  );
  const summary = changes.map((change) => SUMMARY[change.kind]);
  if (exhausted) summary.push("stopped watching");
  const checksOnly = changes.every(
    (change) => change.kind === "checks-failed" || change.kind === "checks-passed",
  );
  return {
    text,
    ...(checksOnly && input.headSha !== null ? { checksOn: input.headSha } : {}),
    notification: {
      source: { kind: "monitor" },
      outcome: failed
        ? "failed"
        : changes.every((change) => change.kind === "checks-passed")
          ? "completed"
          : "updated",
      summary: `#${input.number}: ${summary.join(", ")}`,
    },
  };
}

export interface PullRequestWatchWake {
  readonly text: string;
  readonly notification: OrchestrationV2Notification;
  /** The head this wake reports only check results for; a push makes them stale. */
  readonly checksOn?: string;
}

/**
 * Turns a report into what the reactor records: the watch to save, and either a wake, or a
 * timeline note for updates kept as context. The watch carries only this pass's kept fragments;
 * the orchestrator merges them into the ones not told yet and folds those into the next notice
 * turn that starts (#1055). A watch that spent its comment limit ends with its wake, which tells
 * what the watch kept: `settle` records this pass first, so its fragments merge and settle with
 * the stored ones under the thread lock, and the ending wake reads the result there.
 */
export function pullRequestWatchOutcome(input: {
  readonly number: number;
  readonly url: string;
  readonly baseBranch: string;
  readonly report: PullRequestWatchReport;
}): {
  readonly next: ThreadPullRequestWatch | null;
  /** An ending watch keeps what this pass saw, so watching again starts from it. */
  readonly endedWatch?: ThreadPullRequestWatch;
  /** Progress to record before the watch ends on its wake. */
  readonly settle?: ThreadPullRequestWatch;
  readonly wake?: PullRequestWatchWake;
  readonly note?: OrchestrationV2Notification;
} {
  const { report } = input;
  const { heldContext: _told, ...next } = report.next;
  const context = {
    baseBranch: input.baseBranch,
    commit: next.headSha === null ? "" : ` on ${next.headSha.slice(0, 7)}`,
  };
  const held = report.held.map((change) => heldFragment(change, context));
  const kept = held.length === 0 ? next : { ...next, heldContext: held };
  if (report.changes.length > 0) {
    return {
      ...(report.exhausted ? { next: null, endedWatch: next, settle: kept } : { next: kept }),
      wake: pullRequestWatchMessage({
        number: input.number,
        url: input.url,
        baseBranch: input.baseBranch,
        headSha: next.headSha,
        report,
      }),
    };
  }
  if (held.length === 0) return { next };
  return {
    next: kept,
    note: {
      source: { kind: "monitor" },
      outcome: "updated",
      summary: `#${input.number}: ${report.held.map((change) => SUMMARY[change.kind]).join(", ")}, kept as context`,
      detail: report.held.flatMap((change) => changeLines(change, context)).join("\n"),
    },
  };
}
