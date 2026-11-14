import type {
  EnvironmentId,
  GoatBotEventSubject,
  MemoryReportReference,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2TurnItem,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";

import { parseGoatBotQuote } from "./quote.ts";
import { goatBotPreviewText } from "@goat/shared/goatBotPreviewText";
import {
  answerReferenceOf,
  decidedAnswerInputs,
  foldTaskQuestionAnswer,
} from "./rowsAnswerReferences.ts";

/** The quote and the person's words of a reply; nothing for a message that quotes nothing. */
const quotedParts = (text: string): { readonly quote?: string; readonly reply?: string } => {
  const parsed = parseGoatBotQuote(text);
  return parsed.quote === undefined ? {} : { quote: parsed.quote, reply: parsed.text };
};

/**
 * GOAT Bot's messenger timeline. Only conversation survives: the user's
 * messages, the bot's replies and one card per piece of work. The bot thread
 * holds no tool calls; activitySteps.ts reads them from the session and worker
 * threads and places a collapsed line between these rows, which it leaves as
 * they are.
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
  /** The task's attempt this card shows; 1 when the chip names none. */
  readonly generation?: number;
  /** Failed or stopped work on this machine, which a person may run again. */
  readonly retryable?: boolean;
  readonly summary: string | null;
  /** The work has ended: done, failed or cancelled. */
  readonly ended?: boolean;
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
  /** Which input answered which of the task's questions; absent from older servers. */
  readonly answeredQuestions?: ReadonlyArray<GoatBotAnsweredQuestion>;
}

export interface GoatBotAnsweredQuestion {
  readonly questionId: string;
  readonly inputId?: string | undefined;
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
  /** The attempt of that task the message speaks for; null when the server did not say. */
  readonly taskGeneration?: number | null;
  /** Answers a bot question offers. */
  readonly options?: ReadonlyArray<string>;
  /** The question those answers belong to. */
  readonly questionId?: string;
  /** "task" when that question is the task's own, which the server records answers to. */
  readonly questionKind?: "task";
  /** On a person's message sent from a task question's card: the question when the server took
   *  the answer, null when it refused it. */
  readonly answersQuestionId?: string | null;
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
  /** The task question this send answers, from its card. */
  readonly questionId?: string;
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
      /**
       * A reply's quoted source and the person's own words after it. `text` stays whole, so a
       * client that does not draw the quote still shows what was sent.
       */
      readonly quote?: string;
      readonly reply?: string;
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
      /** Every answer the question offered, kept after it is answered; absent without choices. */
      readonly choices?: ReadonlyArray<string>;
      /** What the person sent back to a question, picked from its answers or typed. */
      readonly answer?: string;
      /** The input represented by a choice folded into this question. */
      readonly answerInputRowId?: string;
      /** Which of `choices` the answer is, when the person picked one. */
      readonly answerIndex?: number;
      /** The picked answer is still on its way; the question shows that in place of the pick's own message. */
      readonly answerSending?: boolean;
      /** When the picked answer was sent, for previews that read it as the newest message. */
      readonly answeredAt?: string;
      /** The task a picked answer goes to, so it answers this question wherever it is pressed. */
      readonly answerTaskId?: string;
      /** The task question a pick answers, sent so the server records which message answered. */
      readonly answerQuestionId?: string;
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
      /** The routine or task the line names, which a client can open. */
      readonly subject?: GoatBotEventSubject;
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
  // A card keeps its first place when a later revision updates it, so the newest by time wins.
  type Shown = Exclude<GoatBotRow, { readonly kind: "day" | "event" }>;
  const changedAt = (row: Shown) =>
    Date.parse(row.kind === "task" ? row.card.updatedAt : row.createdAt);
  let last: Shown | undefined;
  for (const row of input.rows) {
    if (row.kind === "day" || row.kind === "event") continue;
    if (last === undefined || changedAt(row) >= changedAt(last)) last = row;
  }
  if (!last) return null;
  // A pick shown inside its question is still the person's message, newest when nothing came after.
  const lastAt = last.kind === "task" ? last.card.updatedAt : last.createdAt;
  const newestPick = input.rows.findLast(
    (row) => row.kind === "bot" && row.answerIndex !== undefined && row.answeredAt !== undefined,
  );
  const picked =
    newestPick?.kind === "bot" &&
    newestPick.answeredAt !== undefined &&
    Date.parse(newestPick.answeredAt) >= Date.parse(lastAt)
      ? { answer: newestPick.answer ?? "", at: newestPick.answeredAt }
      : null;
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
      picked !== null
        ? `You: ${goatBotPreviewText(picked.answer)}`
        : last.kind === "user"
          ? `You: ${goatBotPreviewText(last.reply ?? last.text) || (last.attachments ?? []).map((file) => file.name).join(", ")}`
          : last.kind === "bot"
            ? goatBotPreviewText(last.text)
            : `${last.card.statusLabel}: ${last.card.title}`,
    at: picked?.at ?? lastAt,
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
  /** When the task last changed; a question it closed was open until then. */
  readonly updatedAt?: string;
  readonly askInChat?: boolean;
  readonly openQuestionIds?: ReadonlyArray<string>;
  readonly answeredQuestions?: ReadonlyArray<GoatBotAnsweredQuestion>;
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
      updatedAt: chip.updatedAt,
      ...(chip.askInChat === true ? { askInChat: true } : {}),
      ...(chip.openQuestionIds === undefined ? {} : { openQuestionIds: chip.openQuestionIds }),
      ...(chip.answeredQuestions === undefined
        ? {}
        : { answeredQuestions: chip.answeredQuestions }),
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
  /**
   * The main chat shows conversation only: a work card stays in its task's own view when the
   * bot's work list (`knownTaskIds`) can open it; cards of tasks outside that list still show.
   */
  readonly conversationOnly?: boolean;
  /**
   * The main chat, and a task's view for that task's own questions, show which message answered
   * a task question from what the server recorded, never by guessing from times or words. On only
   * where the client's card sends answers with their question; off keeps the older matching.
   */
  readonly answerReferences?: boolean;
}): GoatBotRow[] {
  const knownTasks = new Set(input.knownTaskIds ?? []);
  const listedTasks = new Set(input.knownTaskIds ?? []);
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
  const references = input.answerReferences === true && input.taskId !== undefined;
  // A task's own view takes references for that task only.
  const referencesFor = (taskId: string | null | undefined) =>
    references && (input.taskId === null || taskId === input.taskId);
  const decidedInputs = references
    ? decidedAnswerInputs([...newestCards.values(), ...newestQuestionChips.values()])
    : new Map<string, string>();
  const answerReference = answerReferenceOf(decidedInputs);
  // Sends a task question's record or card governs; the older matching never takes them.
  const referenceSends = new Set<string>();
  const taskQuestions = new Map<string, string>();
  const answerRowByQuestion = new Map<string, number>();
  const isOutcome = (presentation: GoatBotMessagePresentation | null) =>
    presentation?.tone === "result" || presentation?.tone === "failure";
  const mainChat = input.conversationOnly === true && input.taskId == null;
  // A retry reuses the task id and its single card, so a message matches the card's attempt by
  // the generation both carry. A message without one cannot be matched and leaves the card shown.
  const toldGenerations = new Map<string, Set<number>>();
  for (const { item } of input.visibleTurnItems) {
    if (item.type !== "assistant_message") continue;
    const presentation = input.readers.message(item);
    if (presentation?.taskId == null || presentation.taskGeneration == null) continue;
    if (!isOutcome(presentation)) continue;
    const told = toldGenerations.get(presentation.taskId) ?? new Set<number>();
    told.add(presentation.taskGeneration);
    toldGenerations.set(presentation.taskId, told);
  }
  const endedCard = (taskId: string) => {
    const newest = newestCards.get(taskId);
    return newest?.ended === true ? newest : undefined;
  };
  /**
   * A task's outcome shows once per view. The main chat tells it as a message where the work list
   * opens the task, and keeps the card where it does not, or where no message told how the
   * card's attempt ended.
   */
  const cardInMainChat = (key: string) => {
    if (!listedTasks.has(key)) return true;
    const ended = endedCard(key);
    return ended !== undefined && toldGenerations.get(key)?.has(ended.generation ?? 1) !== true;
  };
  /**
   * An ended card with a summary tells the outcome of the attempt it ended, where it shows; a
   * running card's summary is progress, and another attempt's message is its own history.
   */
  const cardTellsOutcome = (presentation: GoatBotMessagePresentation | null) => {
    const taskId = presentation?.taskId;
    if (taskId == null || presentation?.taskGeneration == null) return false;
    const ended = endedCard(taskId);
    return (
      ended?.summary != null &&
      (ended.generation ?? 1) === presentation.taskGeneration &&
      (input.taskId === taskId || (mainChat && cardInMainChat(taskId)))
    );
  };
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
  const openOnCard = new Set<string>();
  const sentTasks = new Map<string, string | null>();
  const committed: UngroupedRow[] = [];
  // Requests the person made in this view, so a task's reply to one of them is part of it.
  const mainInputs = new Set<string>();
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
      const verdict = referencesFor(presentation?.taskId)
        ? answerReference(presentation?.answersQuestionId, presentation?.requestKey)
        : undefined;
      // Sent from a question's card and refused: it stays here as what the person said, and
      // never answers another question.
      const refusedAnswer = verdict === null;
      const referenced = refusedAnswer ? undefined : verdict;
      // The option they pressed stays beside the question, including after its buttons close.
      const answersShownQuestion =
        refusedAnswer ||
        referenced !== undefined ||
        (input.taskId === null &&
          presentation?.taskId != null &&
          shownQuestionOptions.get(presentation.taskId)?.has(item.text) === true);
      if (!includesMessage(presentation?.taskId) && !answersShownQuestion) continue;
      if (answersShownQuestion && presentation?.requestKey != null) {
        answeredRequestKeys.add(presentation.requestKey);
      }
      previousInputKey = presentation?.requestKey ?? null;
      sentTasks.set(item.id, presentation?.taskId ?? null);
      if (refusedAnswer) referenceSends.add(item.id);
      if (referenced !== undefined) {
        referenceSends.add(item.id);
        const decided = presentation?.requestKey
          ? decidedInputs.get(presentation.requestKey)
          : undefined;
        if (decided !== undefined) answerRowByQuestion.set(decided, committed.length);
      }
      if (input.taskId == null && presentation?.requestKey) mainInputs.add(presentation.requestKey);
      committed.push({
        kind: "user",
        id: item.id,
        sendKey: null,
        requestKey: presentation?.requestKey ?? null,
        text: item.text,
        ...quotedParts(item.text),
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
      // Without work cards the chat still hears from its tasks: the reply to a request made here,
      // what a task asks, and how the work ended.
      const toldInChat =
        input.conversationOnly === true &&
        input.taskId == null &&
        (presentation?.tone === "result" ||
          presentation?.tone === "failure" ||
          presentation?.tone === "question" ||
          (presentation?.replyToKey != null && mainInputs.has(presentation.replyToKey)));
      if (!includesMessage(presentation?.taskId, hasOptions) && !repliesToAnswer && !toldInChat)
        continue;
      if (isOutcome(presentation) && cardTellsOutcome(presentation)) continue;
      const tone = presentation?.tone ?? "reply";
      const open = questionOpen(presentation?.taskId, presentation?.questionId);
      if (open !== null) cardDecidesOptions.add(item.id);
      if (open === true) openOnCard.add(item.id);
      const taskQuestion =
        referencesFor(presentation?.taskId) &&
        presentation?.questionKind === "task" &&
        presentation.questionId
          ? presentation.questionId
          : undefined;
      if (taskQuestion !== undefined) taskQuestions.set(item.id, taskQuestion);
      if (
        taskQuestion === undefined &&
        input.taskId === null &&
        hasOptions &&
        presentation?.taskId != null
      ) {
        const options = shownQuestionOptions.get(presentation.taskId) ?? new Set<string>();
        for (const option of presentation.options ?? []) options.add(option);
        shownQuestionOptions.set(presentation.taskId, options);
      }
      if (
        taskQuestion === undefined &&
        hasOptions &&
        open !== false &&
        presentation?.taskId != null
      ) {
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
        ...(hasOptions ? { choices: presentation?.options ?? NO_OPTIONS } : {}),
        // Only a server that names the question also routes an answer sent to its task.
        // A task's own question names itself, so a pick answers it even before its card
        // arrives; the server refuses one for a question that has closed.
        ...((open === true || (taskQuestion !== undefined && open === null)) && presentation?.taskId
          ? { answerTaskId: presentation.taskId }
          : {}),
        ...(open !== false && presentation?.taskId && taskQuestion !== undefined
          ? { answerQuestionId: taskQuestion }
          : {}),
        ...(presentation?.memory === undefined ? {} : { memory: presentation.memory }),
      });
      // The conversation is now about what this reply answered; a later reply about it needs no quote.
      previousInputKey = presentation?.replyToKey ?? null;
      continue;
    }
    if (item.type === "notification") {
      if (item.source.kind === "goat_bot_event" && item.ledgerTask === undefined) {
        // Event lines describe the bot: the main chat shows them, a single task's view does not.
        if (input.taskId == null) {
          committed.push({
            kind: "event",
            id: item.id,
            text: item.summary,
            ...(item.source.subject === undefined ? {} : { subject: item.source.subject }),
            createdAt: itemCreatedAt(item),
          });
        }
        continue;
      }
      const card = input.readers.taskCard(item);
      if (card === null) continue;
      if (input.taskId != null && card.key !== input.taskId) continue;
      if (mainChat && !cardInMainChat(card.key)) continue;
      const existingIndex = cardIndexByKey.get(card.key);
      if (existingIndex === undefined) {
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
              tasksWithOpenQuestion.has(entry.taskId) ||
              (references && entry.questionId !== undefined)))) &&
        !committedRequestKeys.has(entry.clientKey) &&
        (entry.requestKey === null || !committedRequestKeys.has(entry.requestKey)),
    )
    .map((entry) => {
      sentTasks.set(`pending:${entry.clientKey}`, entry.taskId ?? null);
      if (referencesFor(entry.taskId) && entry.questionId !== undefined)
        referenceSends.add(`pending:${entry.clientKey}`);
      return {
        kind: "user",
        id: `pending:${entry.clientKey}`,
        sendKey: entry.clientKey,
        requestKey: entry.requestKey,
        text: entry.text,
        ...quotedParts(entry.text),
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
  const orderedIndex = new Map(ordered.map((row, index) => [row.id, index]));
  // Each task question's first own send still on its way (queued or sending), found once.
  const sendingByQuestion = new Map<string, number>();
  for (const entry of input.pendingInputs) {
    if (entry.questionId === undefined) continue;
    if (entry.state !== "queued" && entry.state !== "sending") continue;
    const at = orderedIndex.get("pending:" + entry.clientKey);
    if (at !== undefined && !sendingByQuestion.has(entry.questionId))
      sendingByQuestion.set(entry.questionId, at);
  }
  // Choices answer the question they came with. The task's card says when that question closed,
  // and it stays open until then; without a card, anything the user sent since answers it. A send
  // that failed answers nothing. A later question of the same conversation takes the replies after
  // it. One walk back keeps the nearest later send and question, overall and per task.
  let nearestSend: number | undefined;
  let nearestQuestion: number | undefined;
  const nearestSendByTask = new Map<string | null | undefined, number>();
  const nearestQuestionByTask = new Map<string | null | undefined, number>();
  // A picked choice shows inside its question, so the person's message saying it again is left out.
  const folded = new Set<string>();
  for (let index = ordered.length - 1; index >= 0; index--) {
    const row = ordered[index]!;
    if (row.kind === "user") {
      if (row.delivery.state === "failed" || referenceSends.has(row.id)) continue;
      nearestSend = index;
      nearestSendByTask.set(sentTasks.get(row.id), index);
      continue;
    }
    if (row.kind !== "bot" || !askedQuestions.has(row.id)) continue;
    const taskId = askedQuestions.get(row.id) ?? null;
    const taskQuestion = taskQuestions.get(row.id);
    if (taskQuestion !== undefined) {
      const decidedAt = answerRowByQuestion.get(taskQuestion);
      const decided = decidedAt === undefined ? undefined : ordered[decidedAt];
      // Until the record names the answer, the person's own send to it still on its way.
      const sendingRow = sendingByQuestion.get(taskQuestion);
      const answer =
        decided?.kind === "user"
          ? decided
          : sendingRow !== undefined && ordered[sendingRow]?.kind === "user"
            ? ordered[sendingRow]
            : undefined;
      const result = foldTaskQuestionAnswer(row, answer?.kind === "user" ? answer : undefined);
      ordered[index] = result.row;
      if (result.folded !== undefined) folded.add(result.folded);
    } else if (openOnCard.has(row.id)) {
      // The task's card still lists the question while a pick is on its way or not yet recorded:
      // the person's next message to its task, one of its choices, is that pick until a newer card
      // shows the task saw it and kept the question open.
      const send = taskId === null ? undefined : nearestSendByTask.get(taskId);
      const until = nearestQuestionByTask.get(taskId);
      const candidate =
        send !== undefined && send === nearestSend && (until === undefined || send < until)
          ? ordered[send]
          : undefined;
      const cardAt = questionState(taskId)?.updatedAt;
      const unseen =
        candidate?.kind === "user" &&
        (candidate.sendKey !== null ||
          cardAt === undefined ||
          Date.parse(cardAt) <= Date.parse(candidate.createdAt));
      if (unseen && candidate?.kind === "user" && (candidate.attachments ?? []).length === 0) {
        const answer = candidate.text.trim();
        const answerIndex = (row.choices ?? []).indexOf(answer);
        if (answerIndex >= 0) {
          folded.add(candidate.id);
          ordered[index] = {
            ...row,
            options: NO_OPTIONS,
            answer,
            answerIndex,
            answerInputRowId: candidate.id,
            answeredAt: candidate.createdAt,
            ...(candidate.delivery.state === "queued" || candidate.delivery.state === "sending"
              ? { answerSending: true }
              : {}),
          };
        }
      }
    } else {
      const decidedByCard = cardDecidesOptions.has(row.id);
      const send = decidedByCard
        ? taskId === null
          ? undefined
          : nearestSendByTask.get(taskId)
        : nearestSend;
      const until = decidedByCard ? nearestQuestionByTask.get(taskId) : nearestQuestion;
      const reply = send !== undefined && (until === undefined || send < until) ? send : undefined;
      // A question its task's card closed was open until that card changed; a message sent after
      // that did not answer it.
      const closedAt = decidedByCard ? questionState(taskId)?.updatedAt : undefined;
      const candidate = reply === undefined ? undefined : ordered[reply];
      const answered =
        candidate !== undefined &&
        closedAt !== undefined &&
        Date.parse(candidate.createdAt) > Date.parse(closedAt)
          ? undefined
          : candidate;
      if (answered?.kind === "user") {
        const answer =
          answered.text.trim() || (answered.attachments ?? []).map((file) => file.name).join(", ");
        const answerIndex =
          (answered.attachments ?? []).length === 0 ? (row.choices ?? []).indexOf(answer) : -1;
        // Only the person's next message after the question can be its pick.
        const picked = answerIndex >= 0 && reply === nearestSend;
        if (picked) folded.add(answered.id);
        const sending =
          picked && (answered.delivery.state === "queued" || answered.delivery.state === "sending");
        ordered[index] = {
          ...row,
          options: NO_OPTIONS,
          answer,
          ...(picked
            ? { answerIndex, answeredAt: answered.createdAt, answerInputRowId: answered.id }
            : {}),
          ...(sending ? { answerSending: true } : {}),
        };
      } else if (!decidedByCard && send !== undefined) {
        ordered[index] = { ...row, options: NO_OPTIONS };
      }
    }
    nearestQuestion = index;
    nearestQuestionByTask.set(askedQuestions.get(row.id), index);
  }
  const shown = folded.size === 0 ? ordered : ordered.filter((row) => !folded.has(row.id));

  const rows: GoatBotRow[] = [];
  // The receipt belongs to the newest message sent, even when that message is a pick shown in its question.
  const lastUserId = ordered.findLast((row) => row.kind === "user")?.id;
  const breaks = shown.map((row, index) => {
    const previous = index === 0 ? null : shown[index - 1]!;
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
  for (const [index, row] of shown.entries()) {
    const { stamp, first } = breaks[index]!;
    if (stamp)
      rows.push({
        kind: "day",
        id: `day:${localDayKey(row.createdAt)}:${row.id}`,
        at: row.createdAt,
      });
    const last = index === shown.length - 1 || breaks[index + 1]!.first;
    const groupPosition = first ? (last ? "single" : "first") : last ? "last" : "middle";
    rows.push(
      row.kind === "user"
        ? { ...row, firstInGroup: first, groupPosition, showReceipt: row.id === lastUserId }
        : { ...row, firstInGroup: first, groupPosition },
    );
  }
  return rows;
}
