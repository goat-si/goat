import type {
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2TurnItem,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * GOAT Bot's messenger timeline. Only conversation survives: the user's
 * messages, the bot's replies and one card per piece of work. Tool calls,
 * reasoning, plans and the rest of a coding run stay in the worker thread.
 *
 * The types here are display models with finished labels. Channel metadata
 * reaches them through readers, so this module never mirrors wire contracts.
 */

export type GoatBotBotTone = "reply" | "status" | "result" | "question" | "failure";
export type GoatBotCardTone = "neutral" | "active" | "attention" | "success" | "danger";

export type GoatBotCardTarget =
  | { readonly kind: "thread"; readonly environmentId: EnvironmentId; readonly threadId: ThreadId }
  | { readonly kind: "none"; readonly label: string };

export interface GoatBotTaskCard {
  /** Identifies the work across updates; a newer revision replaces an older card. */
  readonly key: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly title: string;
  readonly statusLabel: string;
  readonly tone: GoatBotCardTone;
  /** The requester, prefixed by the originating channel for requests made elsewhere. */
  readonly sourceLabel: string | null;
  readonly summary: string | null;
  /** Something waiting on a person, such as "2 questions". */
  readonly attentionLabel: string | null;
  readonly target: GoatBotCardTarget;
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
  readonly text: string;
  readonly createdAt: string;
  readonly state: "sending" | "accepted" | "failed";
  /** The server's identity for the input once it has accepted it. */
  readonly requestKey: string | null;
  /** A final rejection cannot be retried with this input's key. */
  readonly rejectionReason?: string;
}

export type GoatBotDelivery =
  | { readonly state: "sending" }
  | { readonly state: "failed"; readonly clientKey: string; readonly rejectionReason?: string }
  | { readonly state: "sent" }
  | { readonly state: "read"; readonly readAt: string };

export type GoatBotRow =
  | { readonly kind: "day"; readonly id: string; readonly at: string }
  | {
      readonly kind: "user";
      readonly id: string;
      readonly text: string;
      readonly createdAt: string;
      readonly delivery: GoatBotDelivery;
      readonly firstInGroup: boolean;
    }
  | {
      readonly kind: "bot";
      readonly id: string;
      readonly text: string;
      readonly createdAt: string;
      readonly tone: GoatBotBotTone;
      readonly replyTo: string | null;
      readonly firstInGroup: boolean;
    }
  | {
      readonly kind: "task";
      readonly id: string;
      readonly createdAt: string;
      readonly card: GoatBotTaskCard;
      readonly firstInGroup: boolean;
    };

/** Messages further apart than this start a new group. */
const GOAT_BOT_GROUP_GAP_MS = 5 * 60 * 1000;

type ContentRow = Exclude<GoatBotRow, { kind: "day" }>;
type UngroupedRow =
  | Omit<Extract<ContentRow, { kind: "user" }>, "firstInGroup">
  | Omit<Extract<ContentRow, { kind: "bot" }>, "firstInGroup">
  | Omit<Extract<ContentRow, { kind: "task" }>, "firstInGroup">;

function itemCreatedAt(item: OrchestrationV2TurnItem): string {
  return DateTime.formatIso(item.startedAt ?? item.updatedAt);
}

function localDayKey(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function side(row: UngroupedRow): "user" | "bot" {
  return row.kind === "user" ? "user" : "bot";
}

export function buildGoatBotTimeline(input: {
  readonly visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly pendingInputs: ReadonlyArray<GoatBotPendingInput>;
  readonly readers: GoatBotItemReaders;
}): GoatBotRow[] {
  const committed: UngroupedRow[] = [];
  const committedRequestKeys = new Set<string>();
  const inputTexts = new Map<string, string>();
  let previousInputKey: string | null = null;
  // One card per piece of work: the first position, the newest revision.
  const cardIndexByKey = new Map<string, number>();

  for (const { item } of input.visibleTurnItems) {
    if (item.type === "user_message") {
      if (item.text.trim().length === 0) continue;
      const presentation = input.readers.message(item);
      if (presentation?.requestKey) {
        committedRequestKeys.add(presentation.requestKey);
        inputTexts.set(presentation.requestKey, item.text);
      }
      if (presentation?.clientKey) committedRequestKeys.add(presentation.clientKey);
      previousInputKey = presentation?.requestKey ?? null;
      committed.push({
        kind: "user",
        id: item.id,
        text: item.text,
        createdAt: itemCreatedAt(item),
        delivery: presentation?.readAt
          ? { state: "read", readAt: presentation.readAt }
          : { state: "sent" },
      });
      continue;
    }
    if (item.type === "assistant_message") {
      if (item.text.trim().length === 0) continue;
      const presentation = input.readers.message(item);
      committed.push({
        kind: "bot",
        id: item.id,
        text: item.text,
        createdAt: itemCreatedAt(item),
        tone: presentation?.tone ?? "reply",
        replyTo:
          presentation?.replyToKey && presentation.replyToKey !== previousInputKey
            ? (inputTexts.get(presentation.replyToKey)?.slice(0, 160) ?? null)
            : null,
      });
      previousInputKey = null;
      continue;
    }
    if (item.type === "notification") {
      const card = input.readers.taskCard(item);
      if (card === null) continue;
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
        !committedRequestKeys.has(entry.clientKey) &&
        (entry.requestKey === null || !committedRequestKeys.has(entry.requestKey)),
    )
    .map((entry) => ({
      kind: "user",
      id: `pending:${entry.clientKey}`,
      text: entry.text,
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
            : { state: "sending" },
    }));

  const rows: GoatBotRow[] = [];
  let previous: UngroupedRow | null = null;
  for (const row of [...committed, ...pending]) {
    const day = localDayKey(row.createdAt);
    const newDay = previous === null || localDayKey(previous.createdAt) !== day;
    if (newDay) rows.push({ kind: "day", id: `day:${day}:${row.id}`, at: row.createdAt });
    const gap =
      previous === null
        ? Number.POSITIVE_INFINITY
        : Date.parse(row.createdAt) - Date.parse(previous.createdAt);
    const firstInGroup =
      newDay ||
      previous === null ||
      side(previous) !== side(row) ||
      !(gap <= GOAT_BOT_GROUP_GAP_MS);
    rows.push({ ...row, firstInGroup });
    previous = row;
  }
  return rows;
}
