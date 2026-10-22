// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a plain Node script that reads campaign rows; no Effect runtime.
/**
 * Turns run.ts rows into the campaign report.
 *
 *   node scripts/agent-surface/eval/report.ts --campaign <campaign.json> runs.jsonl [more.jsonl]
 *
 * Every run is printed beside the medians, failed runs stay in the failure rate, and
 * contaminated runs are listed with their reason and left out of every ratio.
 */
import * as NodeFS from "node:fs";

import {
  type ArmSummary,
  CampaignError,
  MIN_CLEAN_RUNS,
  type RunRow,
  gate,
  summarizeTask,
  validateTaskSet,
} from "./core.ts";

const cell = (value: number | null) => (value === null ? "-" : String(value));
const percent = (value: number | null) => (value === null ? "-" : (value * 100).toFixed(0) + "%");
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
  ].join(" | ") +
  " |";

const main = () => {
  const campaignPath = process.argv[process.argv.indexOf("--campaign") + 1];
  const files = process.argv
    .slice(2)
    .filter((arg, index, all) => arg !== "--campaign" && all[index - 1] !== "--campaign");
  if (!process.argv.includes("--campaign") || campaignPath === undefined || files.length === 0) {
    console.error("usage: report.ts --campaign <campaign.json> <runs.jsonl> [more.jsonl]");
    return 2;
  }
  const campaign = JSON.parse(NodeFS.readFileSync(campaignPath, "utf8")) as {
    baselineArm: string;
    candidateArm: string;
  };
  // Every fixture and check name is accepted: the report judges rows, it does not run tasks.
  const anything = { has: () => true } as unknown as ReadonlySet<string>;
  const taskSet = validateTaskSet(
    JSON.parse(NodeFS.readFileSync(new URL("./tasks.json", import.meta.url), "utf8")),
    { fixtures: anything, checks: anything },
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
  const summaries = taskSet.tasks.map((task) => summarizeTask(task, rows, campaign));
  const verdict = gate(summaries);
  const out: Array<string> = [
    "# goat_eval measurement",
    "",
    "Gate: " + (verdict.pass ? "**pass**" : "**not met** (" + verdict.notPassed.join("; ") + ")"),
    "",
    "Model turns are a range: tool rounds + 1 to tool calls + 1. Medians use successful clean runs; " +
      "a task needs " +
      MIN_CLEAN_RUNS +
      " clean runs per arm.",
  ];
  for (const summary of summaries) {
    out.push(
      "",
      "## " + summary.task + " (" + summary.claim + "): " + summary.verdict,
      ...summary.reasons.map((reason) => "- " + reason),
      "",
      "| arm | runs | contaminated | failed | failure rate | went first | median model turns | median tool calls |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      armLine(summary.baseline),
      armLine(summary.candidate),
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
              row.metrics.toolCalls) +
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
