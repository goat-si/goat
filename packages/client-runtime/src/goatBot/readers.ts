import {
  type ChannelKind,
  type ChannelMessageKind,
  type ChannelTaskChip,
  type ChannelTaskStatus,
  isGoatBotSessionThreadId,
} from "@goat/contracts";
import {
  channelEvidenceIsMeaningful,
  channelPersonEvidenceLabels,
  splitChannelResultText,
} from "@goat/shared/channelEvidence";

import type {
  GoatBotBotTone,
  GoatBotCardTone,
  GoatBotItemReaders,
  GoatBotMessagePresentation,
  GoatBotPullRequestLink,
  GoatBotTaskCard,
} from "./rows.ts";
import { isRetryableTaskStatus, taskAttemptLabel } from "./retry.ts";

const MESSAGE_TONE = {
  inbound: "reply",
  receipt: "reply",
  status: "status",
  result: "result",
  question: "question",
  failure: "failure",
} as const satisfies Record<ChannelMessageKind, GoatBotBotTone>;

const TASK_STATUS = {
  received: { label: "Received", tone: "neutral" },
  dispatching: { label: "Starting", tone: "active" },
  running: { label: "Working", tone: "active" },
  waiting_input: { label: "Needs your input", tone: "attention" },
  completed: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
} as const satisfies Record<ChannelTaskStatus, { label: string; tone: GoatBotCardTone }>;

/**
 * One name and tone per task status, so the sidebar, task pane, Work panel and cards agree.
 * A task the person marked done reads as done whatever its run status is.
 */
export function presentTaskStatus(
  status: ChannelTaskStatus,
  doneAt?: string | null,
): {
  readonly label: string;
  readonly tone: GoatBotCardTone;
} {
  return TASK_STATUS[doneAt ? "completed" : status];
}

const SOURCE_PREFIX = {
  goat: null,
  slack: "Slack",
  mcp: "Agent",
  imessage: "iMessage",
} as const satisfies Record<ChannelKind, string | null>;

/** Before a worker exists the task is still being taken in; afterwards a missing one is unusual. */
function workerlessLabel(status: ChannelTaskStatus): string {
  return status === "received" || status === "dispatching" ? "Not started yet" : "No worker thread";
}

function countLabel(count: number, noun: string): string | null {
  if (count <= 0) return null;
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}

/**
 * What waits on a person comes first: questions, tool approvals, a sign-in, an unresumed usage
 * limit. Only without those does a finished task with neither a report nor a written result say
 * so ("Finished." is the server's text when the worker wrote nothing).
 */
function attentionLabel(chip: ChannelTaskChip, summary: string): string | null {
  const needsYou = chip.observed?.needsYou ?? [];
  const count = (kind: (typeof needsYou)[number]["kind"]) =>
    needsYou.filter((item) => item.kind === kind).length;
  const parts = [
    countLabel(chip.openQuestionCount + count("question"), "question"),
    countLabel(count("approval"), "approval"),
    count("sign_in") > 0 ? "Sign-in needed" : null,
    count("usage_limit") > 0 ? "Usage limit: resume needed" : null,
  ].filter((part) => part !== null);
  if (parts.length > 0) return parts.join(" · ");
  if (
    chip.status === "completed" &&
    chip.completionReport === "missing" &&
    (summary === "" || summary === "Finished.")
  ) {
    return "Finished without a report";
  }
  if (chip.observed?.usageLimitResetAt !== undefined) return "Usage limit: resumes after reset";
  return null;
}

function pullRequestLinks(chip: ChannelTaskChip): ReadonlyArray<GoatBotPullRequestLink> {
  return (chip.observed?.pullRequests ?? []).map((pullRequest) => {
    const detail =
      pullRequest.state !== undefined && pullRequest.state !== "open"
        ? pullRequest.state
        : pullRequest.watching
          ? "watching"
          : null;
    return {
      key: `${pullRequest.repository}#${pullRequest.number}`,
      label: detail === null ? `#${pullRequest.number}` : `#${pullRequest.number} · ${detail}`,
      url: pullRequest.url,
    };
  });
}

/**
 * Verification a person reads on the card. Questions answered without code show none; code work
 * shows its checks and, from the agent's report, what it did not run.
 */
function verificationLabels(chip: ChannelTaskChip, notRun: string | null): ReadonlyArray<string> {
  const result = chip.observed?.result;
  const codeWork =
    channelEvidenceIsMeaningful(result) || (chip.observed?.pullRequests ?? []).length > 0;
  if (!codeWork) return [];
  const skipped = notRun === null || /^none\.?$/iu.test(notRun) ? [] : [`Not run: ${notRun}`];
  return [...channelPersonEvidenceLabels(result), ...skipped];
}

export function presentTaskChip(chip: ChannelTaskChip): GoatBotTaskCard {
  const status = TASK_STATUS[chip.status];
  const prefix = SOURCE_PREFIX[chip.originKind];
  const report = splitChannelResultText(chip.summary ?? "");
  const summary = report.text;
  const host = chip.worker?.host;
  const placement = chip.placementReason?.trim() ?? "";
  const placementLabel =
    host !== undefined && placement.startsWith(host + " · ")
      ? placement.slice(host.length + 3)
      : placement;
  // In GOAT itself the requester is the person reading the card, so naming them says nothing.
  const requester = prefix === null ? null : `${prefix} · ${chip.requesterLabel}`;
  const sourceLabel = [
    ...(requester === null ? [] : [requester]),
    ...(host === undefined ? [] : [`on ${host}`]),
    ...(placementLabel === "" ? [] : [placementLabel]),
  ].join(" · ");
  return {
    key: chip.taskId,
    revision: chip.taskVersion,
    updatedAt: chip.updatedAt,
    title: chip.title,
    statusLabel: status.label,
    tone: status.tone,
    sourceLabel: sourceLabel === "" ? null : sourceLabel,
    continuationLabel:
      chip.movedFrom === undefined ? null : `Continued from ${chip.movedFrom.host}`,
    attemptLabel: taskAttemptLabel(chip.generation),
    generation: chip.generation ?? 1,
    // Work that ran on another machine is checked there; the server refuses to rerun it here.
    retryable:
      isRetryableTaskStatus(chip.status) && host === undefined && chip.movedFrom === undefined,
    summary: summary.length > 0 ? summary : null,
    ended: chip.status === "completed" || chip.status === "failed" || chip.status === "cancelled",
    attentionLabel: attentionLabel(chip, summary),
    evidenceLabels: verificationLabels(chip, report.notRun),
    pullRequests: pullRequestLinks(chip),
    ...(chip.askInChat === true ? { askInChat: true } : {}),
    ...(chip.openQuestionIds === undefined ? {} : { openQuestionIds: chip.openQuestionIds }),
    ...(chip.answeredQuestions === undefined ? {} : { answeredQuestions: chip.answeredQuestions }),
    target:
      chip.worker === undefined
        ? { kind: "none", label: workerlessLabel(chip.status) }
        : {
            kind: "thread",
            environmentId: chip.worker.environmentId,
            threadId: chip.worker.threadId,
            ...(host === undefined ? {} : { host }),
          },
  };
}

/**
 * Reads GOAT Bot's channel metadata off thread items. Items from before the
 * bot, or with metadata this build cannot decode, read as plain messages.
 */
export const goatBotItemReaders: GoatBotItemReaders = {
  message: (item): GoatBotMessagePresentation | null => {
    const meta = item.channel;
    if (meta === undefined) return null;
    return {
      tone: MESSAGE_TONE[meta.kind],
      ...(item.type !== "assistant_message" || meta.memory === undefined
        ? {}
        : { memory: meta.memory }),
      readAt: meta.readAt ?? null,
      requestKey: meta.inputId ?? null,
      replyToKey: meta.inReplyToInputId ?? null,
      clientKey: meta.clientMessageId ?? (item.type === "user_message" ? item.messageId : null),
      ...(meta.taskId === undefined ? {} : { taskId: meta.taskId }),
      ...(meta.taskGeneration === undefined ? {} : { taskGeneration: meta.taskGeneration }),
      ...(meta.options === undefined || meta.options.length === 0 ? {} : { options: meta.options }),
      ...(meta.questionId === undefined ? {} : { questionId: meta.questionId }),
      ...(meta.questionKind === undefined ? {} : { questionKind: meta.questionKind }),
      ...(meta.answersQuestionId === undefined
        ? {}
        : { answersQuestionId: meta.answersQuestionId }),
    };
  },
  taskCard: (item) =>
    item.ledgerTask === undefined || isGoatBotTurn(item.ledgerTask)
      ? null
      : presentTaskChip(item.ledgerTask),
};

/** GOAT Bot answering in its own session; the conversation already shows that as its reply. */
export function isGoatBotTurn(chip: ChannelTaskChip): boolean {
  // Older chips lack their kind, but a turn's worker is always the bot's session thread.
  return (
    chip.kind === "turn" ||
    (chip.worker !== undefined && isGoatBotSessionThreadId(chip.worker.threadId))
  );
}
