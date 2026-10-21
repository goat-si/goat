import type {
  ChannelKind,
  ChannelMessageKind,
  ChannelTaskChip,
  ChannelTaskStatus,
} from "@goat/contracts";
import { channelEvidenceLabels } from "@goat/shared/channelEvidence";

import type {
  GoatBotBotTone,
  GoatBotCardTone,
  GoatBotItemReaders,
  GoatBotMessagePresentation,
  GoatBotPullRequestLink,
  GoatBotTaskCard,
} from "./rows.ts";

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
 * What waits on a person, whatever the task's status says: questions on the task or in the worker
 * thread, tool approvals, a provider sign-in, or a usage limit nothing will resume on its own. A
 * finished task whose worker never reported its outcome is worth a second look too.
 */
function attentionLabel(chip: ChannelTaskChip): string | null {
  if (chip.status === "completed" && chip.completionReport === "missing") {
    return "Finished without a report";
  }
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

export function presentTaskChip(chip: ChannelTaskChip): GoatBotTaskCard {
  const status = TASK_STATUS[chip.status];
  const prefix = SOURCE_PREFIX[chip.originKind];
  const summary = chip.summary?.trim() ?? "";
  const host = chip.worker?.host;
  const placement = chip.placementReason?.trim() ?? "";
  const requester = prefix === null ? chip.requesterLabel : `${prefix} · ${chip.requesterLabel}`;
  return {
    key: chip.taskId,
    revision: chip.taskVersion,
    updatedAt: chip.updatedAt,
    title: chip.title,
    statusLabel: status.label,
    tone: status.tone,
    sourceLabel: [
      requester,
      ...(host === undefined ? [] : [`on ${host}`]),
      ...(placement === "" ? [] : [placement]),
    ].join(" · "),
    continuationLabel:
      chip.movedFrom === undefined ? null : `Continued from ${chip.movedFrom.host}`,
    summary: summary.length > 0 ? summary : null,
    attentionLabel: attentionLabel(chip),
    evidenceLabels: channelEvidenceLabels(chip.observed?.result),
    pullRequests: pullRequestLinks(chip),
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
      clientKey: item.type === "user_message" ? item.messageId : null,
      ...(meta.options === undefined || meta.options.length === 0 ? {} : { options: meta.options }),
    };
  },
  taskCard: (item) => (item.ledgerTask === undefined ? null : presentTaskChip(item.ledgerTask)),
};
