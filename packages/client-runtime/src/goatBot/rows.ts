import type {
  EnvironmentId,
  MemoryReportReference,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2TurnItem,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";

import { goatBotPreviewText } from "./previewText.ts";

/**
 * GOAT Bot's messenger timeline. Only conversation survives: the user's
 * messages, the bot's replies and one card per piece of work. Tool calls,
 * reasoning, plans and the rest of a coding run stay in the worker thread.
 *
 * The types here are display models with finished labels. Channel metadata
 * reaches them through readers. A turn is not a card, but its chip still says
 * which questions are open.
 */

export type GoatBotBotTone = "reply" | "status" | "result" | "question" | "failure";
export type GoatBotCardTone = "neutral" | "active" | "attention" | "success" | "danger";

export type GoatBotCardTarget =
  | {
      readonly kind: "thread";
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      /** The SSH alias of the machine running remote work; absent for this machine. */
      readonly host?: string;
    }
  | { readonly kind: "none"; readonly label: string };

export interface GoatBotTaskCard {
  /** Identifies the work across updates; a newer revision replaces an older card. */
  readonly key: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly title: string;
  readonly statusLabel: string;
  readonly tone: GoatBotCardTone;
  /**
   * The requester, prefixed by the originating channel for requests made elsewhere and followed
   * by the machine that runs remote work and why the work was placed there.
   */
  readonly sourceLabel: string | null;
  /** The machine whose copied work this task continued from. */
  readonly continuationLabel?: string | null;
  /** "Attempt 2" after a person retried the task. */
  readonly attemptLabel?: string | null;
  /** Failed or stopped work on this machine, which a person may run again. */
  readonly retryable?: boolean;
  readonly summary: string | null;
  /** Something waiting on a person, such as "2 questions · 1 approval". */
  readonly attentionLabel: string | null;
  readonly evidenceLabels?: ReadonlyArray<string>;
  /** Pull requests the worker opened or linked, newest state first known. */
  readonly pullRequests: ReadonlyArray<GoatBotPullRequestLink>;
  readonly target: GoatBotCardTarget;
  /** Its question belongs in the main chat as well as the task's own view. */
  readonly askInChat?: boolean;
  /** The task's open questions; absent on cards from servers that did not send them. */
  readonly openQuestionIds?: ReadonlyArray<string>;
}

export interface GoatBotPullRequestLink {
  readonly key: string;
  /** Such as "#42 · merged" or "#42 · watching". */
  readonly label: string;
  readonly url: string;
}

export interface GoatBotMessagePresentation {
  /** How a bot message reads. Ignored for the user's own messages. */
  readonly tone: GoatBotBotTone;
  /** When GOAT Bot started reading the user's message. */
  readonly readAt: string | null;
  /** The server's identity for the input, matched against pending sends. */
  readonly requestKey: string | null;
  readonly replyToKey?: string | null;
  readonly clientKey?: string | null;
  /** The work a bot message is about, such as the task its acknowledgement started. */
  readonly taskId?: string | null;
  /** Answers a bot question offers. */
  readonly options?: ReadonlyArray<string>;
  /** The question those answers belong to. */
  readonly questionId?: string;
  readonly memory?: MemoryReportReference;
}

type MessageItem = Extract<OrchestrationV2TurnItem, { type: "user_message" | "assistant_message" }>;
type NotificationItem = Extract<OrchestrationV2TurnItem, { type: "notification" }>;

export interface GoatBotItemReaders {
  readonly message: (item: MessageItem) => GoatBotMessagePresentation | null;
  readonly taskCard: (item: NotificationItem) => GoatBotTaskCard | null;
}

export interface GoatBotPendingInput {
  /** Made once per submission and reused by every retry of it. */
  readonly clientKey: string;
  /** The bot conversation it goes to; each bot's chat shows only its own. */
  readonly threadId?: string;
  readonly taskId?: string;
  readonly text: string;
  readonly attachments?: ReadonlyArray<GoatBotAttachmentLabel>;
  readonly createdAt: string;
  readonly state: "queued" | "sending" | "accepted" | "failed";
  /** The server's identity for the input once it has accepted it. */
  readonly requestKey: string | null;
  /** A final rejection cannot be retried with this input's key. */
  readonly rejectionReason?: string;
}

export type GoatBotDelivery =
  | { readonly state: "queued" }
  | { readonly state: "sending" }
  | { readonly state: "failed"; readonly clientKey: string; readonly rejectionReason?: string }
  | { readonly state: "sent" }
  | { readonly state: "delivered" }
  | { readonly state: "read"; readonly readAt: string };

export type GoatBotGroupPosition = "single" | "first" | "middle" | "last";

/** A file the person sent with a message, as its bubble names it. */
export interface GoatBotAttachmentLabel {
  readonly id: string;
  readonly type: string;
  readonly name: string;
}

export type GoatBotRow =
  | { readonly kind: "day"; readonly id: string; readonly at: string }
  | {
      readonly kind: "user";
      readonly id: string;
      /** This client's key for a message it is still sending; null once the server row exists. */
      readonly sendKey: string | null;
      /**
       * The server's input id. A pending row gets it when the server accepts the message and the
       * committed row carries the same id, which lets a view follow one message across both.
       */
      readonly requestKey: string | null;
      readonly text: string;
      readonly attachments?: ReadonlyArray<GoatBotAttachmentLabel>;
      readonly createdAt: string;
      readonly delivery: GoatBotDelivery;
      readonly firstInGroup: boolean;
      readonly groupPosition: GoatBotGroupPosition;
      readonly showReceipt: boolean;
    }
  | {
      readonly kind: "bot";
      readonly id: string;
      readonly text: string;
      readonly createdAt: string;
      readonly tone: GoatBotBotTone;
      readonly proactive: boolean;
      readonly replyTo: string | null;
      /** Answers to pick, only while nothing has been sent since the question. */
      readonly options: ReadonlyArray<string>;
      /** What the person sent back to a question, picked from its answers or typed. */
      readonly answer?: string;
      /** The task a picked answer goes to, so it answers this question wherever it is pressed. */
      readonly answerTaskId?: string;
      readonly memory?: MemoryReportReference;
      readonly firstInGroup: boolean;
      readonly groupPosition: GoatBotGroupPosition;
    }
  | {
      readonly kind: "task";
      readonly id: string;
      readonly createdAt: string;
      readonly card: GoatBotTaskCard;
      readonly firstInGroup: boolean;
      readonly groupPosition: GoatBotGroupPosition;
    }
  | {
      /** A line about the bot itself, such as a rename or a paused routine. */
      readonly kind: "event";
      readonly id: string;
      readonly text: string;
      readonly createdAt: string;
      readonly firstInGroup: boolean;
      readonly groupPosition: GoatBotGroupPosition;
    };

export interface GoatBotConversationPreview {
  readonly text: string;
  readonly at: string;
  readonly unread: boolean;
}

/** The display row stays at a card's first position while its revision can arrive later. */
export function goatBotConversationPreview(input: {
  readonly rows: ReadonlyArray<GoatBotRow>;
  readonly lastVisitedAt: string | null | undefined;
  readonly active: boolean;
}): GoatBotConversationPreview | null {
  const last = input.rows.findLast((row) => row.kind !== "day" && row.kind !== "event");
  if (!last) return null;
  const visitedAt = input.lastVisitedAt
    ? Date.parse(input.lastVisitedAt)
    : Number.NEGATIVE_INFINITY;
  const unread =
    !input.active &&
    input.rows.some(
      (row) =>
        (row.kind === "bot" && Date.parse(row.createdAt) > visitedAt) ||
        (row.kind === "task" && Date.parse(row.card.updatedAt) > visitedAt),
    );
  return {
    text:
      last.kind === "user"
        ? `You: ${goatBotPreviewText(last.text) || (last.attachments ?? []).map((file) => file.name).join(", ")}`
        : last.kind === "bot"
          ? goatBotPreviewText(last.text)
          : `${last.card.statusLabel}: ${last.card.title}`,
    at: last.kind === "task" ? last.card.updatedAt : last.createdAt,
    unread,
  };
}

/** Messages further apart than this start a new group. */
const GOAT_BOT_GROUP_GAP_MS = 5 * 60 * 1000;
/**
 * Reception gives up after 45 seconds and then sends a failure note, so a reply that has not come
 * by this point is not coming and the reading indicator stops.
 */
export const GOAT_BOT_READING_LIMIT_MS = 90_000;
/** A quiet stretch this long gets a centered time stamp, like a new day does. */
const GOAT_BOT_STAMP_GAP_MS = 15 * 60 * 1000;
const NO_OPTIONS: ReadonlyArray<string> = [];

interface GoatBotQuestionState {
  readonly revision: number;
  readonly askInChat?: boolean;
  readonly openQuestionIds?: ReadonlyArray<string>;
}

const questionStateFromChip = (
  item: NotificationItem,
): { readonly key: string; readonly state: GoatBotQuestionState } | null => {
  const chip = item.ledgerTask;
  if (chip === undefined) return null;
  return {
    key: chip.taskId,
    state: {
      revision: chip.taskVersion,
      ...(chip.askInChat === true ? { askInChat: true } : {}),
      ...(chip.openQuestionIds === undefined ? {} : { openQuestionIds: chip.openQuestionIds }),
    },
  };
};

type ContentRow = Exclude<GoatBotRow, { kind: "day" }>;
type UngroupedRow =
  | Omit<Extract<ContentRow, { kind: "user" }>, "firstInGroup" | "groupPosition" | "showReceipt">
  | Omit<Extract<ContentRow, { kind: "bot" }>, "firstInGroup" | "groupPosition">
  | Omit<Extract<ContentRow, { kind: "task" }>, "firstInGroup" | "groupPosition">
  | Omit<Extract<ContentRow, { kind: "event" }>, "firstInGroup" | "groupPosition">;

function itemCreatedAt(item: OrchestrationV2TurnItem): string {
  return DateTime.formatIso(item.startedAt ?? item.updatedAt);
}

function localDayKey(iso: string): string {
  // @effect-diagnostics-next-line globalDate:off - day separators follow the device's local calendar.
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function side(row: UngroupedRow): "user" | "bot" | "event" {
  return row.kind === "user" ? "user" : row.kind === "event" ? "event" : "bot";
}

const attachmentLabels = (
  attachments: ReadonlyArray<GoatBotAttachmentLabel> | undefined,
): { readonly attachments?: ReadonlyArray<GoatBotAttachmentLabel> } =>
  attachments === undefined || attachments.length === 0
    ? {}
    : { attachments: attachments.map(({ id, type, name }) => ({ id, type, name })) };

/**
 * When GOAT Bot started reading the newest message it has not answered yet, or null.
 * Reception replies to every input it reads, even when it fails, so an input stays
 * unanswered only while its reply is being written.
 */
export function goatBotReplyingSince(input: {
  readonly visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly readers: GoatBotItemReaders;
}): string | null {
  const answered = new Set<string>();
  for (const { item } of input.visibleTurnItems) {
    if (item.type !== "assistant_message") continue;
    const replyTo = input.readers.message(item)?.replyToKey;
    if (replyTo) answered.add(replyTo);
  }
  for (let index = input.visibleTurnItems.length - 1; index >= 0; index -= 1) {
    const item = input.visibleTurnItems[index]?.item;
    if (item?.type !== "user_message") continue;
    const presentation = input.readers.message(item);
    if (!presentation?.readAt || !presentation.requestKey) continue;
    return answered.has(presentation.requestKey) ? null : presentation.readAt;
  }
  return null;
}

export function buildGoatBotTimeline(input: {
  readonly visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly pendingInputs: ReadonlyArray<GoatBotPendingInput>;
  readonly readers: GoatBotItemReaders;
  readonly taskId?: string | null;
  readonly knownTaskIds?: ReadonlyArray<string>;
}): GoatBotRow[] {
  const knownTasks = new Set(input.knownTaskIds ?? []);
  // Each task's newest card, read before the messages so it also governs messages above it.
  const newestCards = new Map<string, GoatBotTaskCard>();
  const newestQuestionChips = new Map<string, GoatBotQuestionState>();
  for (const { item } of input.visibleTurnItems) {
    if (item.type !== "notification") continue;
    const fromChip = questionStateFromChip(item);
    if (fromChip !== null) {
      const newestChip = newestQuestionChips.get(fromChip.key);
      if (newestChip === undefined || fromChip.state.revision > newestChip.revision) {
        newestQuestionChips.set(fromChip.key, fromChip.state);
      }
    }
    const card = input.readers.taskCard(item);
    if (card === null) continue;
    knownTasks.add(card.key);
    const newest = newestCards.get(card.key);
    if (newest === undefined || card.revision > newest.revision) newestCards.set(card.key, card);
  }
  const questionState = (taskId: string | null | undefined) => {
    if (taskId == null) return undefined;
    const card = newestCards.get(taskId);
    const chip = newestQuestionChips.get(taskId);
    if (card !== undefined && (chip === undefined || card.revision >= chip.revision)) return card;
    return chip;
  };
  const includesMessage = (taskId: string | null | undefined, hasOptions = false) =>
    input.taskId === undefined ||
    (input.taskId === null
      ? taskId == null ||
        !knownTasks.has(taskId) ||
        questionState(taskId)?.askInChat === true ||
        hasOptions
      : taskId === input.taskId);
  /** Whether a question's buttons still apply, when its task's card says; null when it cannot. */
  const questionOpen = (taskId: string | null | undefined, questionId: string | undefined) => {
    const open = questionState(taskId)?.openQuestionIds;
    return questionId === undefined || open === undefined ? null : open.includes(questionId);
  };
  const cardDecidesOptions = new Set<string>();
  const tasksWithOpenQuestion = new Set<string>();
  const shownQuestionOptions = new Map<string, Set<string>>();
  const answeredRequestKeys = new Set<string>();
  // The task each question and each of the person's messages belongs to, so an answer finds its question.
  const askedQuestions = new Map<string, string | null>();
  const sentTasks = new Map<string, string | null>();
  const committed: UngroupedRow[] = [];
  const committedRequestKeys = new Set<string>();
  const inputTexts = new Map<string, string>();
  let previousInputKey: string | null = null;
  // One card per piece of work: the first position, the newest revision.
  const cardIndexByKey = new Map<string, number>();

  for (const { item } of input.visibleTurnItems) {
    if (item.type === "user_message") {
      if (item.text.trim().length === 0 && item.attachments.length === 0) continue;
      const presentation = input.readers.message(item);
      if (presentation?.requestKey) {
        committedRequestKeys.add(presentation.requestKey);
        inputTexts.set(presentation.requestKey, item.text);
      }
      if (presentation?.clientKey) committedRequestKeys.add(presentation.clientKey);
      // The option they pressed stays beside the question, including after its buttons close.
      const answersShownQuestion =
        input.taskId === null &&
        presentation?.taskId != null &&
        shownQuestionOptions.get(presentation.taskId)?.has(item.text) === true;
      if (!includesMessage(presentation?.taskId) && !answersShownQuestion) continue;
      if (answersShownQuestion && presentation?.requestKey != null) {
        answeredRequestKeys.add(presentation.requestKey);
      }
      previousInputKey = presentation?.requestKey ?? null;
      sentTasks.set(item.id, presentation?.taskId ?? null);
      committed.push({
        kind: "user",
        id: item.id,
        sendKey: null,
        requestKey: presentation?.requestKey ?? null,
        text: item.text,
        ...attachmentLabels(item.attachments),
        createdAt: itemCreatedAt(item),
        delivery: presentation?.readAt
          ? { state: "read", readAt: presentation.readAt }
          : { state: "delivered" },
      });
      continue;
    }
    if (item.type === "assistant_message") {
      if (item.text.trim().length === 0) continue;
      const presentation = input.readers.message(item);
      const hasOptions = (presentation?.options?.length ?? 0) > 0;
      const repliesToAnswer =
        input.taskId === null &&
        presentation?.replyToKey != null &&
        answeredRequestKeys.has(presentation.replyToKey);
      if (!includesMessage(presentation?.taskId, hasOptions) && !repliesToAnswer) continue;
      const tone = presentation?.tone ?? "reply";
      const open = questionOpen(presentation?.taskId, presentation?.questionId);
      if (open !== null) cardDecidesOptions.add(item.id);
      if (input.taskId === null && hasOptions && presentation?.taskId != null) {
        const options = shownQuestionOptions.get(presentation.taskId) ?? new Set<string>();
        for (const option of presentation.options ?? []) options.add(option);
        shownQuestionOptions.set(presentation.taskId, options);
      }
      if (hasOptions && open !== false && presentation?.taskId != null) {
        tasksWithOpenQuestion.add(presentation.taskId);
      }
      if (hasOptions || tone === "question")
        askedQuestions.set(item.id, presentation?.taskId ?? null);
      committed.push({
        kind: "bot",
        id: item.id,
        text: item.text,
        createdAt: itemCreatedAt(item),
        tone,
        proactive:
          !presentation?.replyToKey &&
          (tone === "status" || tone === "result" || tone === "question"),
        replyTo:
          presentation?.replyToKey && presentation.replyToKey !== previousInputKey
            ? (inputTexts.get(presentation.replyToKey)?.slice(0, 160) ?? null)
            : null,
        options: open === false ? NO_OPTIONS : (presentation?.options ?? NO_OPTIONS),
        // Only a server that names the question also routes an answer sent to its task.
        ...(open === true && presentation?.taskId ? { answerTaskId: presentation.taskId } : {}),
        ...(presentation?.memory === undefined ? {} : { memory: presentation.memory }),
      });
      previousInputKey = null;
      continue;
    }
    if (item.type === "notification") {
      if (item.source.kind === "goat_bot_event" && item.ledgerTask === undefined) {
        // Event lines describe the bot: the main chat shows them, a single task's view does not.
        if (input.taskId == null) {
          previousInputKey = null;
          committed.push({
            kind: "event",
            id: item.id,
            text: item.summary,
            createdAt: itemCreatedAt(item),
          });
        }
        continue;
      }
      const card = input.readers.taskCard(item);
      if (card === null) continue;
      if (input.taskId != null && card.key !== input.taskId) continue;
      const existingIndex = cardIndexByKey.get(card.key);
      if (existingIndex === undefined) {
        previousInputKey = null;
        cardIndexByKey.set(card.key, committed.length);
        committed.push({ kind: "task", id: item.id, createdAt: itemCreatedAt(item), card });
        continue;
      }
      const existing = committed[existingIndex];
      if (existing?.kind === "task" && card.revision > existing.card.revision) {
        committed[existingIndex] = { ...existing, card };
      }
    }
    // Everything else belongs to the worker's coding view.
  }

  const pending: UngroupedRow[] = input.pendingInputs
    .filter(
      (entry) =>
        (input.taskId === undefined ||
          (entry.taskId ?? null) === input.taskId ||
          (input.taskId === null &&
            entry.taskId !== undefined &&
            (questionState(entry.taskId)?.askInChat === true ||
              tasksWithOpenQuestion.has(entry.taskId)))) &&
        !committedRequestKeys.has(entry.clientKey) &&
        (entry.requestKey === null || !committedRequestKeys.has(entry.requestKey)),
    )
    .map((entry) => {
      sentTasks.set(`pending:${entry.clientKey}`, entry.taskId ?? null);
      return {
        kind: "user",
        id: `pending:${entry.clientKey}`,
        sendKey: entry.clientKey,
        requestKey: entry.requestKey,
        text: entry.text,
        ...attachmentLabels(entry.attachments),
        createdAt: entry.createdAt,
        delivery:
          entry.state === "failed"
            ? {
                state: "failed",
                clientKey: entry.clientKey,
                ...(entry.rejectionReason === undefined
                  ? {}
                  : { rejectionReason: entry.rejectionReason }),
              }
            : entry.state === "accepted"
              ? { state: "sent" }
              : { state: entry.state },
      } satisfies UngroupedRow;
    });

  const ordered = [...committed, ...pending];
  // Choices answer the question they came with. The task's card says when that question closed;
  // without it, anything the user sent since retires them. A send that failed answers nothing.
  for (const [index, row] of ordered.entries()) {
    if (row.kind !== "bot" || !askedQuestions.has(row.id)) continue;
    const taskId = askedQuestions.get(row.id) ?? null;
    const decidedByCard = cardDecidesOptions.has(row.id);
    let answer: string | undefined;
    let retired = false;
    for (const next of ordered.slice(index + 1)) {
      // A later question of the same conversation takes the replies after it.
      if (
        next.kind === "bot" &&
        askedQuestions.has(next.id) &&
        (!decidedByCard || askedQuestions.get(next.id) === taskId)
      )
        break;
      if (next.kind !== "user" || next.delivery.state === "failed") continue;
      if (decidedByCard && (taskId === null || sentTasks.get(next.id) !== taskId)) continue;
      answer = next.text.trim() || (next.attachments ?? []).map((file) => file.name).join(", ");
      retired = true;
      break;
    }
    if (!decidedByCard && !retired) {
      retired = ordered
        .slice(index + 1)
        .some((next) => next.kind === "user" && next.delivery.state !== "failed");
    }
    if (answer !== undefined) ordered[index] = { ...row, options: NO_OPTIONS, answer };
    else if (retired) ordered[index] = { ...row, options: NO_OPTIONS };
  }

  const rows: GoatBotRow[] = [];
  const lastUserIndex = ordered.findLastIndex((row) => row.kind === "user");
  const breaks = ordered.map((row, index) => {
    const previous = index === 0 ? null : ordered[index - 1]!;
    const newDay =
      previous === null || localDayKey(previous.createdAt) !== localDayKey(row.createdAt);
    const gap =
      previous === null
        ? Number.POSITIVE_INFINITY
        : Date.parse(row.createdAt) - Date.parse(previous.createdAt);
    const stamp = newDay || !(gap < GOAT_BOT_STAMP_GAP_MS);
    const first =
      stamp ||
      previous === null ||
      side(previous) !== side(row) ||
      !(gap <= GOAT_BOT_GROUP_GAP_MS) ||
      (row.kind === "bot" && row.proactive && !(previous?.kind === "bot" && previous.proactive));
    return { stamp, first };
  });
  for (const [index, row] of ordered.entries()) {
    const { stamp, first } = breaks[index]!;
    if (stamp)
      rows.push({
        kind: "day",
        id: `day:${localDayKey(row.createdAt)}:${row.id}`,
        at: row.createdAt,
      });
    const last = index === ordered.length - 1 || breaks[index + 1]!.first;
    const groupPosition = first ? (last ? "single" : "first") : last ? "last" : "middle";
    rows.push(
      row.kind === "user"
        ? { ...row, firstInGroup: first, groupPosition, showReceipt: index === lastUserIndex }
        : { ...row, firstInGroup: first, groupPosition },
    );
  }
  return rows;
}
