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
/** Lines of held context kept for the next wake; older ones are dropped first. */
const HELD_CONTEXT_LINES = 40;
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
      ...(watch.heldContext === undefined ? {} : { heldContext: watch.heldContext }),
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

/** Adds the updates held as context to a message the agent reads, so a wake or an ending loses none. */
export function withHeldContext(
  text: string,
  heldContext: ReadonlyArray<string> | undefined,
): string {
  return heldContext === undefined || heldContext.length === 0
    ? text
    : [text, "", "Earlier updates GOAT kept as context without waking you:", ...heldContext].join(
        "\n",
      );
}

function pullRequestWatchMessage(input: {
  readonly number: number;
  readonly url: string;
  readonly baseBranch: string;
  readonly headSha: string | null;
  readonly report: PullRequestWatchReport;
  /** Lines kept as context since the last wake, told with this one. */
  readonly heldContext?: ReadonlyArray<string>;
}): PullRequestWatchWake {
  const { changes, exhausted } = input.report;
  const context = {
    baseBranch: input.baseBranch,
    commit: input.headSha === null ? "" : ` on ${input.headSha.slice(0, 7)}`,
  };
  const text = [
    withHeldContext(
      [
        `Update on pull request #${input.number} (${input.url}), which GOAT is watching for you:`,
        ...changes.flatMap((change) => changeLines(change, context)),
      ].join("\n"),
      input.heldContext,
    ),
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
 * timeline note for updates kept as context. Held lines ride along with the next wake, then
 * clear. A watch that spent its comment limit ends with its wake.
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
  const { heldContext: earlier = [], ...next } = report.next;
  const context = {
    baseBranch: input.baseBranch,
    commit: next.headSha === null ? "" : ` on ${next.headSha.slice(0, 7)}`,
  };
  const heldLines = report.held.flatMap((change) => changeLines(change, context));
  if (report.changes.length > 0) {
    return {
      ...(report.exhausted ? { next: null, endedWatch: next } : { next }),
      wake: pullRequestWatchMessage({
        number: input.number,
        url: input.url,
        baseBranch: input.baseBranch,
        headSha: next.headSha,
        report,
        heldContext: [...earlier, ...heldLines].slice(-HELD_CONTEXT_LINES),
      }),
    };
  }
  if (heldLines.length === 0) return { next: report.next };
  return {
    next: { ...next, heldContext: [...earlier, ...heldLines].slice(-HELD_CONTEXT_LINES) },
    note: {
      source: { kind: "monitor" },
      outcome: "updated",
      summary: `#${input.number}: ${report.held.map((change) => SUMMARY[change.kind]).join(", ")}, kept as context`,
      detail: heldLines.join("\n"),
    },
  };
}
