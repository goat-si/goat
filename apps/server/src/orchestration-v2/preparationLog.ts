import { ORCHESTRATION_V2_PROVIDER_FAILURE_LOG_MAX_CHARS } from "@goat/contracts";

import { redactLogText } from "../observability/LogRedaction.ts";

/**
 * The bounded log of one workspace preparation: what GOAT did, and the end of the Git and
 * setup script output. It is kept only to explain a failure, so it holds the last lines,
 * redacted on the way in because it ends up in the thread and in launch reports.
 */
export type PreparationLog = ReadonlyArray<string>;

const MAX_LINES = 40;
const LINE_MAX_CHARS = 300;

// Git redraws progress such as "Receiving objects:  45% (900/2000)"; only the latest counts.
const PROGRESS = /^(.{1,80}?):\s+\d{1,3}%/;

export function appendPreparationLine(log: PreparationLog, raw: string): PreparationLog {
  const trimmed = raw.trimEnd();
  if (trimmed.trim().length === 0) return log;
  const redacted = redactLogText(trimmed);
  const line =
    redacted.length <= LINE_MAX_CHARS ? redacted : `${redacted.slice(0, LINE_MAX_CHARS - 1)}…`;
  const step = PROGRESS.exec(line)?.[1];
  const previous = log.at(-1);
  const replacesPrevious =
    step !== undefined && previous !== undefined && PROGRESS.exec(previous)?.[1] === step;
  return [...(replacesPrevious ? log.slice(0, -1) : log), line].slice(-MAX_LINES);
}

/** The log as one text, cut from the front to fit a failure; null when nothing was logged. */
export function renderPreparationLog(log: PreparationLog): string | null {
  if (log.length === 0) return null;
  const text = log.join("\n");
  if (text.length <= ORCHESTRATION_V2_PROVIDER_FAILURE_LOG_MAX_CHARS) return text;
  const cut = text.slice(text.length - ORCHESTRATION_V2_PROVIDER_FAILURE_LOG_MAX_CHARS + 2);
  return `…\n${cut.slice(cut.indexOf("\n") + 1)}`;
}
