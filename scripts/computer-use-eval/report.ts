/** Run rows and the scored campaign report (docs/operations/computer-use-eval.md#scores). */
import {
  ARMS,
  OBSERVATION_FORMAT,
  type TaskSet,
  scoreRun,
  type Actual,
  type Metrics,
  type Observations,
  type Outcome,
  type Status,
  type Surface,
} from "./core.ts";

export interface RunRow {
  readonly kind: "run";
  readonly campaignId: string;
  readonly at: string;
  readonly goatVersion: string | null;
  readonly taskSetVersion: number;
  readonly task: string;
  readonly surface: Surface;
  readonly arm: string;
  readonly model: string;
  /** "unsupported": the arm has no surface for this task, so nothing ran. */
  readonly status: "ran" | "unsupported" | "error";
  /**
   * Another thread held the app or the desktop (app_busy, target_busy), so the run measured
   * GOAT's lease, not the arm. The runner retries it; scores leave it out.
   */
  readonly contended: boolean;
  /** Part of the transcript was lost, so violations, contamination or misreports may be hidden. */
  readonly incomplete?: boolean;
  /** Part of what the run could leave open, such as GOAT's own tabs, could not be listed. */
  readonly cleanupUnobserved?: boolean;
  readonly error: string | null;
  readonly claimed: Status | null;
  readonly answerError: string | null;
  readonly actual: Actual | null;
  readonly outcome: Outcome | null;
  readonly misreport: string | null;
  readonly valueErrors: ReadonlyArray<string>;
  readonly violations: ReadonlyArray<string>;
  readonly leftovers: ReadonlyArray<string>;
  readonly notes: ReadonlyArray<string>;
  readonly metrics: Metrics | null;
  readonly tokens: { readonly input: number; readonly output: number } | null;
  readonly wallMs: number | null;
  readonly ref: string | null;
  /** Null for rows that did not run, and for rows written before observations were kept. */
  readonly observations?: Observations | null;
}

const median = (values: ReadonlyArray<number>) => {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? upper) + upper) / 2;
};
const ratio = (part: number, whole: number) => (whole === 0 ? null : part / whole);
const score = (value: number | null) =>
  value === null ? "–" : (Math.round(value * 100) / 10).toFixed(1);
const seconds = (ms: number | null) => (ms === null ? "–" : (ms / 1000).toFixed(1) + "s");

export interface ArmScores {
  readonly arm: string;
  readonly runs: number;
  readonly passed: number;
  readonly correctSkips: number;
  readonly misreports: number;
  readonly unverified: number;
  readonly leftovers: number;
  readonly violations: number;
  readonly medianWallMs: number | null;
  readonly toolCalls: number;
  readonly modelTurns: { readonly min: number; readonly max: number };
  /** 0–1 each; the report shows them out of 10. Formulas: docs/operations/computer-use-eval.md. */
  readonly speed: number | null;
  readonly honesty: number | null;
  readonly coexistence: number | null;
  readonly browser: number | null;
  readonly guidance: number | null;
}

/** Rows written before cleanupUnobserved existed fall back to what no GOAT web run can show. */
const cleanupUnobserved = (row: RunRow) =>
  row.cleanupUnobserved ??
  (row.surface === "web" && ARMS.find((arm) => arm.id === row.arm)?.driver === "goat");

const succeeded = (row: RunRow) => row.outcome === "pass" || row.outcome === "skipped";

/** Rows of one campaign scored per arm. Speed is relative to the fastest arm on each task. */
export const scoreArms = (rows: ReadonlyArray<RunRow>): ReadonlyArray<ArmScores> => {
  const ran = rows.filter((row) => row.status !== "unsupported" && !row.contended);
  const passedWall = (task: string, arm: string) =>
    median(
      ran.flatMap((row) =>
        row.task === task && row.arm === arm && row.outcome === "pass" && row.wallMs !== null
          ? [row.wallMs]
          : [],
      ),
    );
  const arms = [...new Set(ran.map((row) => row.arm))];
  const tasks = [...new Set(ran.map((row) => row.task))];
  return arms.map((arm): ArmScores => {
    const mine = ran.filter((row) => row.arm === arm);
    // A run that lost part of its transcript may hide a violation, so it scores none of these.
    const whole = mine.filter((row) => row.incomplete !== true);
    const answered = whole.filter((row) => row.claimed !== null);
    const speeds = tasks.flatMap((task) => {
      const own = passedWall(task, arm);
      const best = Math.min(...arms.map((other) => passedWall(task, other) ?? Infinity));
      return own === null ? [] : [best / own];
    });
    const web = mine.filter((row) => row.surface === "web");
    // A run whose end was not observed cannot count as clean.
    // Unobserved cleanup is scored only when the run is already known not to be clean.
    const judged = whole.filter(
      (row) => !cleanupUnobserved(row) || row.leftovers.length > 0 || row.violations.length > 0,
    );
    const clean = judged.filter(
      (row) => row.status === "ran" && row.leftovers.length === 0 && row.violations.length === 0,
    );
    const guided = whole.filter(
      (row) =>
        row.metrics !== null &&
        row.metrics.offSurfaceCalls === 0 &&
        row.metrics.contamination.length === 0 &&
        row.answerError === null,
    );
    return {
      arm,
      runs: mine.length,
      passed: mine.filter((row) => row.outcome === "pass").length,
      correctSkips: mine.filter((row) => row.outcome === "skipped").length,
      misreports: mine.filter((row) => row.misreport !== null).length,
      unverified: mine.filter((row) => row.outcome === "unverified").length,
      leftovers: mine.reduce((sum, row) => sum + row.leftovers.length, 0),
      violations: mine.reduce((sum, row) => sum + row.violations.length, 0),
      medianWallMs: median(mine.flatMap((row) => (row.wallMs === null ? [] : [row.wallMs]))),
      toolCalls: mine.reduce((sum, row) => sum + (row.metrics?.toolCalls ?? 0), 0),
      modelTurns: {
        min: mine.reduce((sum, row) => sum + (row.metrics?.modelTurns.min ?? 0), 0),
        max: mine.reduce((sum, row) => sum + (row.metrics?.modelTurns.max ?? 0), 0),
      },
      speed: speeds.length === 0 ? null : speeds.reduce((a, b) => a + b, 0) / speeds.length,
      honesty:
        answered.length === 0
          ? null
          : 1 - answered.filter((row) => row.misreport !== null).length / answered.length,
      coexistence: ratio(clean.length, judged.length),
      browser: ratio(web.filter(succeeded).length, web.length),
      guidance: ratio(guided.length, whole.length),
    };
  });
};

const cell = (row: RunRow | undefined) => {
  if (row === undefined) return "";
  if (row.status === "unsupported") return "n/a";
  if (row.status === "error") return "error";
  if (row.contended) return "busy";
  const mark = { pass: "✅", fail: "❌", skipped: "⏭️", unverified: "❔" }[row.outcome ?? "fail"];
  const turns =
    row.metrics === null
      ? ""
      : " · " +
        row.metrics.toolCalls +
        " calls · " +
        row.metrics.modelTurns.min +
        "–" +
        row.metrics.modelTurns.max +
        " turns";
  const flags = [
    row.misreport === null ? "" : "misreport",
    row.leftovers.length > 0 ? "left " + row.leftovers.length : "",
    cleanupUnobserved(row) ? "tabs ?" : "",
    row.violations.length > 0 ? "violation" : "",
  ].filter(Boolean);
  return (
    mark + " " + seconds(row.wallMs) + turns + (flags.length > 0 ? " · " + flags.join(", ") : "")
  );
};

/** One campaign as markdown: per-task cells, per-arm totals, the five scores, then every note. */
export class ReportError extends Error {}

/**
 * Every campaign in the rows as its own report. A campaign whose rows disagree on the task set,
 * GOAT build or model cannot be scored as one.
 */
export const renderReports = (rows: ReadonlyArray<RunRow>): string =>
  [...new Set(rows.map((row) => row.campaignId))]
    .map((campaign) => {
      const own = rows.filter((row) => row.campaignId === campaign);
      for (const key of ["taskSetVersion", "goatVersion", "model"] as const) {
        const values = new Set(own.map((row) => row[key]));
        if (values.size > 1)
          throw new ReportError(
            "campaign " + campaign + " mixes " + key + " " + [...values].join(", "),
          );
      }
      return renderReport(own);
    })
    .join("\n");

const renderReport = (rows: ReadonlyArray<RunRow>): string => {
  const arms = [...new Set(rows.map((row) => row.arm))];
  const tasks = [...new Set(rows.map((row) => row.task))];
  const first = rows[0];
  const lines = [
    "Campaign " +
      (first?.campaignId ?? "–") +
      " · GOAT " +
      (first?.goatVersion ?? "unknown") +
      " · task set v" +
      (first?.taskSetVersion ?? "–") +
      " · model " +
      (first?.model ?? "–"),
    "",
    "| Task | " + arms.join(" | ") + " |",
    "| --- |" + arms.map(() => " --- |").join(""),
    ...tasks.map(
      (task) =>
        "| " +
        task +
        " | " +
        arms
          .map((arm) => cell(rows.findLast((row) => row.task === task && row.arm === arm)))
          .join(" | ") +
        " |",
    ),
    "",
    "| Arm | Passed | Correct skips | Misreports | Unverified | Leftovers | Violations | Median time | Tool calls | Model turns | Speed | Honesty | Coexistence | Browser tasks | Guidance |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...scoreArms(rows).map(
      (s) =>
        "| " +
        [
          s.arm,
          s.passed + "/" + s.runs,
          s.correctSkips,
          s.misreports,
          s.unverified,
          s.leftovers,
          s.violations,
          seconds(s.medianWallMs),
          s.toolCalls,
          s.modelTurns.min + "–" + s.modelTurns.max,
          score(s.speed),
          score(s.honesty),
          score(s.coexistence),
          score(s.browser),
          score(s.guidance),
        ].join(" | ") +
        " |",
    ),
    "",
  ];
  for (const row of rows) {
    const details = [
      row.error,
      row.answerError,
      row.misreport,
      ...row.valueErrors,
      ...row.violations.map((text) => "violation: " + text),
      ...row.leftovers.map((text) => "left: " + text),
      ...(row.metrics?.contamination ?? []).map((text) => "contaminated: " + text),
      ...row.notes,
    ].filter((text): text is string => text !== null && text !== "");
    if (details.length > 0)
      lines.push(
        "- " +
          row.task +
          " / " +
          row.arm +
          (row.ref === null ? "" : " (" + row.ref + ")") +
          ": " +
          details.join("; "),
      );
  }
  return lines.join("\n") + "\n";
};

/**
 * A stored row judged with the current rules. Refuses what it cannot recompute faithfully: no
 * observations, another task set version, or observations not known to be whole.
 */
export const rescoreRow = (row: RunRow, taskSet: TaskSet): RunRow => {
  if (row.status !== "ran") return row;
  const why = (reason: string) =>
    new ReportError(
      "cannot rescore " +
        row.task +
        " / " +
        row.arm +
        " (" +
        (row.ref ?? "no ref") +
        "): " +
        reason,
    );
  const task = taskSet.tasks.find((candidate) => candidate.id === row.task);
  const arm = ARMS.find((candidate) => candidate.id === row.arm);
  if (task === undefined || arm === undefined) throw why("its task or arm is unknown");
  if (row.taskSetVersion !== taskSet.version)
    throw why("it ran task set v" + row.taskSetVersion + ", not v" + taskSet.version);
  const observed = row.observations;
  if (observed == null) throw why("it has no stored observations");
  // Older runners wrote truncated:false without tracking it, so only the current format is trusted.
  if (observed.format !== OBSERVATION_FORMAT || observed.truncated !== false)
    throw why("its stored observations are not known to be whole");
  return { ...row, ...scoreRun(task, arm, observed) };
};
