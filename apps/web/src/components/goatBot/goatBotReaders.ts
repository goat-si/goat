import type {
  ChannelKind,
  ChannelMessageKind,
  ChannelTaskChip,
  ChannelTaskStatus,
} from "@t3tools/contracts";

import type {
  GoatBotBotTone,
  GoatBotCardTone,
  GoatBotItemReaders,
  GoatBotMessagePresentation,
  GoatBotTaskCard,
} from "./goatBotRows";

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
} as const satisfies Record<ChannelKind, string | null>;

/** Before a worker exists the task is still being taken in; afterwards a missing one is unusual. */
function workerlessLabel(status: ChannelTaskStatus): string {
  return status === "received" || status === "dispatching" ? "Not started yet" : "No worker thread";
}

function questionLabel(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "1 question" : `${count} questions`;
}

export function presentTaskChip(chip: ChannelTaskChip): GoatBotTaskCard {
  const status = TASK_STATUS[chip.status];
  const prefix = SOURCE_PREFIX[chip.originKind];
  const summary = chip.summary?.trim() ?? "";
  return {
    key: chip.taskId,
    revision: chip.taskVersion,
    updatedAt: chip.updatedAt,
    title: chip.title,
    statusLabel: status.label,
    tone: status.tone,
    sourceLabel: prefix === null ? chip.requesterLabel : `${prefix} · ${chip.requesterLabel}`,
    summary: summary.length > 0 ? summary : null,
    attentionLabel: questionLabel(chip.openQuestionCount),
    target:
      chip.worker === undefined
        ? { kind: "none", label: workerlessLabel(chip.status) }
        : {
            kind: "thread",
            environmentId: chip.worker.environmentId,
            threadId: chip.worker.threadId,
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
      readAt: meta.readAt ?? null,
      requestKey: meta.inputId ?? null,
      replyToKey: meta.inReplyToInputId ?? null,
      clientKey: item.type === "user_message" ? item.messageId : null,
    };
  },
  taskCard: (item) => (item.ledgerTask === undefined ? null : presentTaskChip(item.ledgerTask)),
};
