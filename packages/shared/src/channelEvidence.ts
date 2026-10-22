import type { ChannelWorkerResult } from "@goat/contracts";

/**
 * Labels keep the agent's claim separate from the command GOAT actually observed. These are the
 * full set an agent or reviewer reads; people see {@link channelPersonEvidenceLabels}.
 */
export function channelEvidenceLabels(
  result: ChannelWorkerResult | undefined,
): ReadonlyArray<string> {
  if (result === undefined) return [];
  const reported =
    result.tests === undefined
      ? "Reported tests: not reported"
      : result.tests.ok
        ? "Reported tests: passed"
        : "Reported tests: failed";
  const check = result.observedCheck;
  if (check === undefined)
    return [
      reported,
      result.observedCheckPending === true
        ? "GOAT check: pending"
        : result.observedCheckPending === false
          ? "GOAT check: not run"
          : "GOAT check: not available",
    ];
  let observed: string;
  switch (check.status) {
    case "running":
      observed = "running";
      break;
    case "completed":
      observed =
        check.exitCode === null
          ? "finished without an exit code"
          : check.exitCode === 0
            ? "passed"
            : `failed (exit ${check.exitCode})`;
      break;
    case "timed_out":
      observed = "timed out";
      break;
    case "interrupted":
      observed = "interrupted";
      break;
    case "skipped":
      observed =
        check.skipReason === "shared-checkout"
          ? "skipped (shared checkout)"
          : check.skipReason === "worktree-missing"
            ? "skipped (worktree missing)"
            : "skipped";
      break;
  }
  return [reported, `GOAT check: ${observed}`];
}

/**
 * Whether verification says anything to a person: an agent reported tests, or GOAT ran or will
 * run its own check. A question answered without code has neither, and showing "not reported"
 * and "not run" there is noise.
 */
export function channelEvidenceIsMeaningful(result: ChannelWorkerResult | undefined): boolean {
  return (
    result !== undefined &&
    (result.tests !== undefined ||
      result.observedCheck !== undefined ||
      result.observedCheckPending === true)
  );
}

/**
 * The labels a person sees. When anything is meaningful all labels stay, so a reported pass is
 * never shown without saying GOAT's own check did not run.
 */
export function channelPersonEvidenceLabels(
  result: ChannelWorkerResult | undefined,
): ReadonlyArray<string> {
  return channelEvidenceIsMeaningful(result) ? channelEvidenceLabels(result) : [];
}

const SENTENCE_PHRASES: ReadonlyArray<readonly [string, string]> = [
  ["Reported tests: not reported", "the agent reported no tests"],
  ["Reported tests: ", "the agent reported tests "],
  ["GOAT check: not run", "GOAT's own check did not run"],
  ["GOAT check: not available", "GOAT's own check is not available"],
  ["GOAT check: pending", "GOAT's own check is pending"],
  ["GOAT check: running", "GOAT's own check is running"],
  ["GOAT check: interrupted", "GOAT's own check was interrupted"],
  ["GOAT check: ", "GOAT's own check "],
];

/**
 * One sentence for a text-only channel such as Slack or iMessage, or null when verification
 * means nothing to a person. It reads as prose in the reply, never as field lines.
 */
export function channelEvidenceSentence(
  result: ChannelWorkerResult | undefined,
  title?: string,
): string | null {
  if (!channelEvidenceIsMeaningful(result)) return null;
  const clauses = channelEvidenceLabels(result).map((label) => {
    const phrase = SENTENCE_PHRASES.find(([prefix]) => label.startsWith(prefix));
    return phrase === undefined ? label : phrase[1] + label.slice(phrase[0].length);
  });
  return (
    (title === undefined ? "Verification: " : "Verification for " + title + ": ") +
    clauses.join("; ") +
    "."
  );
}

/**
 * Report-protocol lines agents add for reviewers ("NOT RUN: …") and evidence labels a model may
 * echo back. The worker's summary is free text, so these are recognised by their fixed prefixes.
 */
const TRAILER_LINE = /^\s*(?:[-*•]\s*)?(NOT RUN:|Reported tests:|GOAT check:)\s*(.*)$/u;

/**
 * Separates a result written for people from the trailers written for agents. `notRun` is the
 * text of the last NOT RUN line, kept so code work can still show it as structured detail.
 */
export function splitChannelResultText(text: string): {
  readonly text: string;
  readonly notRun: string | null;
} {
  let notRun: string | null = null;
  const kept: Array<string> = [];
  for (const line of text.split("\n")) {
    const match = TRAILER_LINE.exec(line);
    if (match === null) {
      kept.push(line);
      continue;
    }
    if (match[1] === "NOT RUN:") notRun = match[2]!.trim();
  }
  return { text: kept.join("\n").trim(), notRun: notRun === "" ? null : notRun };
}
