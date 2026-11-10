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
import * as DateTime from "effect/DateTime";

/** Bounds consecutive comment-only wakes to stop bot reply loops; check, conflict, or push news resets it. */
export const PULL_REQUEST_WATCH_WAKE_LIMIT = 10;
/** How long a head may go without any check before the agent is told none reported. */
export const PULL_REQUEST_WATCH_NO_CHECKS_MS = 15 * 60_000;
const LISTED_ITEMS = 10;
const SNIPPET_LENGTH = 200;
/** Failed checks a held line names before it counts the rest. */
const HELD_CHECK_NAMES = 5;
const DAY_MS = 24 * 60 * 60_000;

export type PullRequestWatchChange =
  | { readonly kind: "checks-failed"; readonly failed: ReadonlyArray<PullRequestCheck> }
  | { readonly kind: "checks-passed"; readonly count: number; readonly required: boolean }
  | { readonly kind: "checks-awaiting-approval"; readonly checks: ReadonlyArray<PullRequestCheck> }
  | { readonly kind: "remarks"; readonly remarks: ReadonlyArray<PullRequestComment> }
  | { readonly kind: "no-checks"; readonly minutes: number }
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
const isFailedCheck = (check: PullRequestCheck) =>
  check.status === "failure" || check.status === "cancelled";

// A GitHub Actions job's URL extends its workflow run's URL; their names need not match.
const workflowRunOf = (url: string | null) => url?.match(/^.*\/actions\/runs\/\d+/)?.[0] ?? null;
const approvalKey = (check: PullRequestCheck) => workflowRunOf(check.url) ?? check.name;

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
  detail: Pick<
    PullRequestDetail,
    "capabilities" | "headSha" | "checks" | "mergeability" | "viewer" | "author"
  >,
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
  const headSha = detail.headSha ?? watch.headSha;
  const headMoved = headSha !== watch.headSha;

  // Hosts can return no checks on read failure; preserve prior state.
  let failedChecks = headMoved ? [] : watch.failedChecks;
  let passed = headMoved ? false : watch.passed;
  let passedChecks = headMoved ? [] : watch.passedChecks;
  let owedChecks = headMoved ? [] : (watch.owedChecks ?? []);
  let awaitingApproval = headMoved ? [] : (watch.awaitingApproval ?? []);
  let approvalAnnounced = headMoved ? false : (watch.approvalAnnounced ?? false);
  // An unavailable approval read cannot establish success or that no checks exist.
  const unread = detail.checks.some((check) => check.placeholder === true);
  const checks = detail.checks.filter((check) => check.placeholder !== true);
  const failed = checks.filter(isFailedCheck);
  const awaiting = checks.filter((check) => check.status === "action-required");
  if (checks.length > 0) {
    const newlyFailed = failed.filter((check) => !failedChecks.includes(check.name));
    if (newlyFailed.length > 0) {
      sort({ kind: "checks-failed", failed: newlyFailed }, policy.checksFailed);
    }
    if (!approvalAnnounced && awaiting.length > 0) {
      sort({ kind: "checks-awaiting-approval", checks: awaiting }, policy.checksFailed);
      approvalAnnounced = true;
    }
    failedChecks = failed.map((check) => check.name);

    // Approval reads can omit gated runs. Keep each hold until its jobs finish.
    const awaitingNow = [...new Set(awaiting.map(approvalKey))];
    const nameUnfinished = (name: string) => {
      const matching = checks.filter((check) => check.name === name);
      return (
        matching.length === 0 ||
        matching.some((check) => check.status === "pending" || check.status === "action-required")
      );
    };
    // GitHub deduplicates jobs across runs, so a visible pending job may hide one in an awaited run.
    // A pending check without a URL could be such a job; one with another host's URL cannot.
    const jobsPending = checks.some(
      (check) =>
        check.status === "pending" && (check.url === null || workflowRunOf(check.url) !== null),
    );
    const finished = new Set(
      jobsPending
        ? []
        : checks
            .filter((check) => check.status !== "action-required" && check.status !== "pending")
            .map((check) => workflowRunOf(check.url)),
    );
    awaitingApproval = [
      ...awaitingNow,
      ...awaitingApproval.filter(
        (key) =>
          !awaitingNow.includes(key) &&
          (workflowRunOf(key) === key ? !finished.has(key) : nameUnfinished(key)),
      ),
    ];
    // Once every approval hold has settled, a later wait on the same head is news again.
    if (awaitingApproval.length === 0) approvalAnnounced = false;
  }
  const required = checks.filter((check) => check.required === true);
  const gate = required.length > 0 ? required : checks;
  const passedNow =
    awaitingApproval.length === 0 &&
    gate.every((check) => check.status !== "pending" && !isFailedCheck(check));
  if (checks.length > 0 && !(unread && passedNow)) {
    const gateNames = gate.map((check) => check.name);
    const told = passed && passedChecks.length === 0 ? gateNames : passedChecks;
    // Required checks can finish between sweeps; detect new names. With no required checks, ignore advisory gate growth.
    const gateGrew = required.length > 0 && gateNames.some((name) => !told.includes(name));
    // Other checks still pending when required ones passed are owed one wake when all settle.
    // Only those are owed, so later advisory churn never wakes. One turned required is gate news.
    const owed =
      passedNow && passed
        ? checks
            .filter((check) => check.required !== true && owedChecks.includes(check.name))
            .map((check) => check.name)
        : [];
    const settled =
      failed.length === 0 &&
      awaitingApproval.length === 0 &&
      checks.every((check) => check.status !== "pending");
    owedChecks = owed;
    if (passedNow && (!passed || gateGrew)) {
      sort(
        { kind: "checks-passed", count: gate.length, required: required.length > 0 },
        policy.checksPassed,
      );
      owedChecks =
        required.length > 0
          ? checks
              .filter((check) => check.required !== true && check.status === "pending")
              .map((check) => check.name)
          : [];
    } else if (settled && owed.length > 0) {
      sort({ kind: "checks-passed", count: checks.length, required: false }, policy.checksPassed);
      owedChecks = [];
    }
    passed = passedNow;
    passedChecks = passedNow ? gateNames : [];
  }

  // Only a head never read with checks waits for them: an empty read after checks were seen is
  // the failed read above. A watch saved before this field may have seen pending checks on its
  // head, so its clock starts only at the next push. Where a host's empty list can mean the
  // repository runs no checks at all, nothing waits.
  let checksAwaitedSince = watch.checksAwaitedSince;
  if (detail.capabilities.checksAlwaysReport === true) {
    const awaitedBefore = headMoved
      ? DateTime.formatIso(DateTime.makeUnsafe(context.now))
      : (watch.checksAwaitedSince ?? null);
    checksAwaitedSince = checks.length > 0 ? null : awaitedBefore;
    const awaitedMs =
      checksAwaitedSince === null ? 0 : context.now - Date.parse(checksAwaitedSince);
    if (!unread && awaitedMs >= PULL_REQUEST_WATCH_NO_CHECKS_MS) {
      // Check news, so the failed-check mode decides whether it wakes.
      sort({ kind: "no-checks", minutes: Math.round(awaitedMs / 60_000) }, policy.checksFailed);
      checksAwaitedSince = null;
    }
  }

  const own = (detail.viewer ?? detail.author?.login)?.toLowerCase();
  const through = Date.parse(watch.remarksThrough);
  const activeAt = (remark: PullRequestComment) => remark.editedAt ?? remark.createdAt;
  // Hosts can stamp remarks to the second, so remarks at the boundary time are told apart by ID.
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

  const toldConflict = !headMoved && watch.conflicting;
  if (detail.mergeability === "conflicting" && !toldConflict) {
    // A base push can conflict every open pull request; a thread nobody touched for days stays
    // asleep. The watch still records the conflict, so it is not reported later either.
    const idle =
      policy.conflictMaxIdleDays !== null &&
      context.now - context.threadActiveAt > policy.conflictMaxIdleDays * DAY_MS;
    sort({ kind: "conflicting" }, idle ? "ignore" : policy.conflicts);
  }
  // "unknown" is a host still computing after a push; only a clean answer clears a conflict.
  const conflicting =
    detail.mergeability === "unknown" ? toldConflict : detail.mergeability === "conflicting";

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
      owedChecks,
      awaitingApproval,
      approvalAnnounced,
      remarksThrough,
      remarkIds,
      conflicting,
      wakes,
      ...(watch.automatic === true ? { automatic: true } : {}),
      checksAwaitedSince,
    },
    exhausted: commentsOnly && wakes >= PULL_REQUEST_WATCH_WAKE_LIMIT,
  };
}

function snippet(body: string): string {
  const text = body
    .replaceAll(/<!--[\s\S]*?-->/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  if (text.length <= SNIPPET_LENGTH) return text;
  const last = text.charCodeAt(SNIPPET_LENGTH - 4);
  const end = last >= 0xd800 && last <= 0xdbff ? SNIPPET_LENGTH - 4 : SNIPPET_LENGTH - 3;
  return `${text.slice(0, end)}...`;
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
    case "checks-awaiting-approval":
      return [
        `- Checks are waiting for approval or action from a maintainer${context.commit}:`,
        ...listed(change.checks, (check) => `  - ${check.name}${check.url ? ` ${check.url}` : ""}`),
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
    case "no-checks":
      return [
        `- No checks have reported${context.commit} after ${change.minutes} minutes. None may be configured to run on this change.`,
      ];
    case "conflicting":
      return [`- The branch now conflicts with ${context.baseBranch}.`];
  }
}

const SUMMARY: Record<PullRequestWatchChange["kind"], string> = {
  "checks-failed": "checks failed",
  "checks-passed": "checks passed",
  "checks-awaiting-approval": "checks await approval",
  remarks: "new comments",
  "no-checks": "no checks reported",
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
      return `checks failed${context.commit}: ${checkNames(change.failed.map((check) => check.name))}`;
    }
    case "checks-passed":
      return `all ${change.count} ${change.required ? "required " : ""}${change.count === 1 ? "check" : "checks"} passed${context.commit}`;
    case "checks-awaiting-approval":
      return `checks await approval${context.commit}: ${checkNames(change.checks.map((check) => check.name))}`;
    case "remarks": {
      const latest = change.remarks.at(-1);
      const where = latest?.path == null ? "" : ` on ${latest.path}`;
      const body = snippet(latest?.body ?? "");
      const said = body.length === 0 ? (latest?.reviewState ?? "reviewed") : `"${body}"`;
      return `${commentCount(change.remarks.length)}, latest from ${latest?.author?.login ?? "someone"}${where}: ${said}${latest?.url ? ` ${latest.url}` : ""}`;
    }
    case "no-checks":
      return `no checks reported${context.commit} after ${change.minutes} minutes`;
    case "conflicting":
      return `conflicts with ${context.baseBranch}`;
  }
}

const commentCount = (count: number) => `${count} new ${count === 1 ? "comment" : "comments"}`;

const checkNames = (names: ReadonlyArray<string>) => {
  const more = names.length - HELD_CHECK_NAMES;
  return `${names.slice(0, HELD_CHECK_NAMES).join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
};

const HELD_KINDS = [
  [
    "checks",
    /^(checks failed|checks await approval|all \d+ (required )?checks? passed|no checks reported)/,
  ],
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
  return mergeHeldContext(heldContext).flatMap((fragment) => {
    switch (heldKind(fragment)) {
      case "conflict":
        return state.conflicting ? [fragment] : [];
      case "checks": {
        // A pass a rerun or a new failure undid no longer holds, nor do failures that cleared.
        if (state.headMoved) return [];
        // "No checks" holds until any check result is recorded on this head.
        if (fragment.startsWith("no checks reported")) {
          return state.passed || state.failedChecks.length > 0 ? [] : [fragment];
        }
        if (!fragment.startsWith("checks failed")) return state.passed ? [fragment] : [];
        if (state.failedChecks.length === 0) return [];
        // Restated from every check failing now: one that passed since leaves the list, and one
        // that failed earlier stays when a newer failure replaces the fragment.
        const head = /^checks failed[^:]*/.exec(fragment)?.[0] ?? "checks failed";
        return [`${head}: ${checkNames(state.failedChecks)}`];
      }
      default:
        return [fragment];
    }
  });
}

/**
 * What a watch keeps once a pass is recorded: the stored fragments settle against the pass's
 * state, the pass's own fragments merge in, and failures are restated from the full failing set.
 */
export function keptAfterPass(
  stored: ReadonlyArray<string> | undefined,
  kept: ReadonlyArray<string> | undefined,
  state: Pick<ThreadPullRequestWatch, "conflicting" | "failedChecks" | "passed"> & {
    readonly headMoved: boolean;
  },
): ReadonlyArray<string> {
  const merged = mergeHeldContext(settleHeldContext(stored, state), kept);
  return settleHeldContext(merged, { ...state, headMoved: false });
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
      : `Look into each item and act on it as your task requires. This PR stays linked and watched, so do not link, watch, or list it again. End your turn when you are done, and GOAT wakes you on the next change. When you hand the work back to the user, call ${goatCallText("pull_request.unwatch")} first so the thread returns to their inbox.`,
  ].join("\n");
  const failed = changes.some(
    (change) => change.kind === "checks-failed" || change.kind === "conflicting",
  );
  const summary = changes.map((change) => SUMMARY[change.kind]);
  if (exhausted) summary.push("stopped watching");
  const checksOnly = changes.every(
    (change) =>
      change.kind === "checks-failed" ||
      change.kind === "checks-passed" ||
      change.kind === "no-checks",
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
 * what the watch kept: the pass's own fragments ride on `endedWatch`, and the orchestrator merges
 * them with the stored ones under the thread lock, in the write that ends the watch.
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
      ...(report.exhausted ? { next: null, endedWatch: kept } : { next: kept }),
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
