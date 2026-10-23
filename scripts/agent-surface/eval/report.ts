// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a plain Node script that reads campaign rows; no Effect runtime.
/**
 * Turns run.ts rows into the campaign report.
 *
 *   node scripts/agent-surface/eval/report.ts --campaign <campaign.json> [--budget <context-budget.json>] \
 *     runs.jsonl [more.jsonl]
 *
 * Every run is printed beside the medians, failed runs stay in the failure rate, and
 * contaminated runs are listed with their reason and left out of every ratio. --budget takes
 * the --json output of scripts/agent-surface/context-budget.ts for the measured commit.
 */
import * as NodeFS from "node:fs";

import {
  type ArmSummary,
  CampaignError,
  CONTROL_TURN_ALLOWANCE,
  MIN_CLEAN_RUNS,
  type RunRow,
  gate,
  summarizeTask,
  validateCampaign,
  validateTaskSet,
} from "./core.ts";

const cell = (value: number | null) => (value === null ? "-" : String(value));
const percent = (value: number | null) => (value === null ? "-" : (value * 100).toFixed(0) + "%");
const seconds = (ms: number | null) => (ms === null ? "-" : (ms / 1000).toFixed(1) + " s");
const armLine = (summary: ArmSummary) =>
  "| " +
  [
    summary.arm,
    summary.runs,
    summary.contaminated,
    summary.failed,
    percent(summary.failureRate),
    summary.wentFirst,
    cell(summary.turnsMin) + " to " + cell(summary.turnsMax),
    cell(summary.toolCalls),
    cell(summary.failedToolCalls),
    cell(summary.resultBytes),
    seconds(summary.wallMs),
  ].join(" | ") +
  " |";

const RULES = {
  eval:
    "A reduction counts only when the candidate's most turns are a third below the baseline's " +
    "fewest, and the control must show no gain.",
  listing:
    "The control may rise by at most " +
    CONTROL_TURN_ALLOWANCE +
    " turn at either end of the range; a multi-step task may not rise at either end; neither may " +
    "fail more often.",
};

interface Budget {
  readonly commit: string;
  readonly dirty: boolean;
  readonly listing: { readonly tools: number; readonly modelFacingBytes: number };
  readonly harnesses: ReadonlyArray<{
    readonly harness: string;
    readonly instructionBytes: number;
    readonly firstPromptBytes: number;
    readonly laterTurnBytes: number;
  }>;
}

const budgetLines = (budget: Budget) => [
  "",
  "## First prompt (context-budget.ts)",
  "",
  "Commit " +
    budget.commit.slice(0, 9) +
    (budget.dirty ? " (dirty tree)" : "") +
    ": " +
    budget.listing.tools +
    " tools, " +
    budget.listing.modelFacingBytes +
    " model-facing listing bytes.",
  "",
  "| harness | instructions | first prompt | every later turn |",
  "| --- | --- | --- | --- |",
  ...budget.harnesses.map(
    (row) =>
      "| " +
      [row.harness, row.instructionBytes, row.firstPromptBytes, row.laterTurnBytes].join(" | ") +
      " |",
  ),
];

const flagValue = (name: string) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const main = () => {
  const campaignPath = flagValue("--campaign");
  const budgetPath = flagValue("--budget");
  const files = process.argv
    .slice(2)
    .filter(
      (arg, index, all) =>
        !arg.startsWith("--") && all[index - 1] !== "--campaign" && all[index - 1] !== "--budget",
    );
  if (campaignPath === undefined || files.length === 0) {
    console.error(
      "usage: report.ts --campaign <campaign.json> [--budget <context-budget.json>] <runs.jsonl> [more.jsonl]",
    );
    return 2;
  }
  // Every fixture and check name is accepted: the report judges rows, it does not run tasks.
  const anything = { has: () => true } as unknown as ReadonlySet<string>;
  const taskSet = validateTaskSet(
    JSON.parse(NodeFS.readFileSync(new URL("./tasks.json", import.meta.url), "utf8")),
    { fixtures: anything, checks: anything },
  );
  const campaign = validateCampaign(
    JSON.parse(NodeFS.readFileSync(campaignPath, "utf8")),
    taskSet,
    [],
  );
  const rows = files.flatMap((file) =>
    NodeFS.readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as RunRow)
      .filter((row) => row.kind === "run"),
  );
  const versions = new Set(rows.map((row) => row.taskSetVersion));
  if (versions.size > 1 || (versions.size === 1 && !versions.has(taskSet.version)))
    throw new CampaignError(
      "rows come from task set " + [...versions].join(", ") + ", not " + taskSet.version,
    );
  const ran = new Set(rows.map((row) => row.task));
  const summaries = taskSet.tasks
    .filter((task) => ran.has(task.id))
    .map((task) => summarizeTask(task, rows, campaign));
  const verdict = gate(summaries);
  const out: Array<string> = [
    campaign.gate === "listing" ? "# Listing measurement" : "# goat_eval measurement",
    "",
    campaign.candidateArm === null
      ? "Baseline only (arm " + campaign.baselineArm + "): numbers, no verdict."
      : "Verdict: " +
        (verdict.pass ? "**pass**" : "**not met** (" + verdict.notPassed.join("; ") + ")"),
    "",
    [
      "Model turns are a range: tool rounds + 1 to tool calls + 1. Medians use successful clean " +
        "runs; a verdict needs " +
        MIN_CLEAN_RUNS +
        " of them per arm.",
      ...(campaign.candidateArm === null ? [] : [RULES[campaign.gate]]),
      "Result bytes are the compact JSON the server returned to the run's tool calls.",
    ].join(" "),
  ];
  if (budgetPath !== undefined)
    out.push(...budgetLines(JSON.parse(NodeFS.readFileSync(budgetPath, "utf8")) as Budget));
  for (const summary of summaries) {
    out.push(
      "",
      "## " + summary.task + " (" + summary.claim + "): " + summary.verdict,
      ...summary.reasons.map((reason) => "- " + reason),
      "",
      "| arm | runs | contaminated | failed | failure rate | went first | median model turns | median tool calls | median failed calls | median result bytes | median wall time |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      armLine(summary.baseline),
      ...(summary.candidate === null ? [] : [armLine(summary.candidate)]),
      "",
    );
    for (const row of rows.filter((candidate) => candidate.task === summary.task))
      out.push(
        "- " +
          row.arm +
          " pair " +
          row.pair +
          ": " +
          (row.contamination.length > 0
            ? "contaminated (" + row.contamination.join("; ") + ")"
            : row.ok
              ? "ok"
              : "failed (" + row.failures.join("; ") + ")") +
          (row.metrics === null
            ? ""
            : ", turns " +
              row.metrics.modelTurns.min +
              " to " +
              row.metrics.modelTurns.max +
              ", calls " +
              row.metrics.toolCalls +
              ", " +
              row.metrics.resultBytes +
              " B") +
          (row.wallMs === null ? "" : ", " + seconds(row.wallMs)) +
          (row.threadId === null ? "" : ", " + row.threadId),
      );
  }
  console.log(out.join("\n"));
  return 0;
};

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof CampaignError ? error.message : error);
  process.exitCode = 1;
}
