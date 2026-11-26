import {
  isChannelTaskTerminal,
  isGoatBotSessionThreadId,
  type BotThreadRow,
  type ChannelTaskChip,
  type ChannelTaskId,
  type EnvironmentId,
  type ModelSelection,
  type ServerProvider,
  type ServerSettings,
  type SlackChannelSettings,
  type SlackChannelStatusEvent,
} from "@goat/contracts";

import { englishDiagnosticMessages, type GoatBotDiagnosticMessages } from "./diagnosticMessages.ts";
export type { GoatBotDiagnosticMessages } from "./diagnosticMessages.ts";
import type { GoatBotFaceTaskItem } from "./face.ts";
import type { GoatBotHomeResolution } from "./home.ts";
import { deriveGoatBotModelSettings } from "./model.ts";

/** listBotThreads returns at most this many tasks, open and recently finished together. */
const BOT_THREADS_PAGE = 100;
const SLACK_DELIVERY_ERROR_WINDOW_MS = 24 * 60 * 60 * 1000;

export type GoatBotDiagnosticTone = "ok" | "pending" | "warn" | "error";

export type GoatBotDiagnosticAction =
  | { readonly kind: "claim_home"; readonly environmentId: EnvironmentId; readonly label: string }
  | { readonly kind: "choose_model"; readonly environmentId: EnvironmentId; readonly label: string }
  | { readonly kind: "open_task"; readonly taskId: ChannelTaskId; readonly label: string }
  | { readonly kind: "open_chat"; readonly label: string }
  | {
      readonly kind: "open_slack_settings";
      readonly environmentId: EnvironmentId;
      readonly label: string;
    };

export interface GoatBotDiagnosticLine {
  readonly key: "home" | "model" | "work" | "slack";
  readonly tone: GoatBotDiagnosticTone;
  readonly text: string;
  readonly action: GoatBotDiagnosticAction | null;
  /** A second way in, when the line counts two kinds of things that each have their own place. */
  readonly alsoAction?: GoatBotDiagnosticAction;
}

export interface GoatBotDiagnostics {
  readonly verdict: "ready" | "checking" | "attention" | "down";
  readonly title: string;
  readonly lines: ReadonlyArray<GoatBotDiagnosticLine>;
}

export interface GoatBotModelStatus {
  readonly model: string;
  readonly provider: string | null;
  /** Offered by an enabled, available provider that is ready, the same test the model picker uses. */
  readonly available: boolean;
  /** A member without its own model, which takes GOAT Bot's model when its session starts. */
  readonly inherited: boolean;
}

/** The bot's model as its home server would run it; `override` is a member's own model (null: none). */
export function goatBotModelStatus(input: {
  readonly settings: ServerSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly override?: ModelSelection | null;
}): GoatBotModelStatus {
  const state = deriveGoatBotModelSettings(input);
  const selection = input.override ?? state.selection;
  const entry = state.entries.find((candidate) => candidate.instanceId === selection.instanceId);
  // The picker leaves out models the person hid; a hidden model still runs, so look it up in the
  // provider's own list too.
  const model =
    entry?.models.find((candidate) => candidate.slug === selection.model) ??
    input.providers
      .find((provider) => provider.instanceId === selection.instanceId)
      ?.models.find((candidate) => !candidate.isCustom && candidate.slug === selection.model);
  return {
    model: model?.name ?? selection.model,
    provider: entry?.displayName ?? null,
    available:
      entry !== undefined &&
      entry.enabled &&
      entry.isAvailable &&
      entry.status === "ready" &&
      model !== undefined,
    inherited: input.override === null,
  };
}

export interface GoatBotDiagnosticsInput {
  readonly home: GoatBotHomeResolution;
  /** The claimed home machine's name. */
  readonly homeLabel: string;
  /** The claimed home is in this app's list and refused this device. Absent: not known to be refused. */
  readonly homeRefused?: boolean;
  /** A connected machine the viewer may make the home; null when there is none. */
  readonly moveTarget: { readonly environmentId: EnvironmentId; readonly label: string } | null;
  readonly member: boolean;
  /** The main bot's name, for a member that uses the main bot's model. */
  readonly mainBotName: string;
  /** Null until the home server's settings and providers have loaded. */
  readonly model: GoatBotModelStatus | null;
  readonly canChangeModel: boolean;
  /** Null until the bot's task rows have loaded; "unavailable" when its server cannot list them. */
  readonly rows: ReadonlyArray<BotThreadRow> | null | "failed" | "unavailable";
  /** The bot's own turns asking the person something; the task list leaves turns out. */
  readonly turnsWaiting: ReadonlyArray<GoatBotWaitingTurn>;
  /** "unavailable" when the home cannot report Slack, which hides the line. */
  readonly slack:
    | ReadonlyArray<
        Pick<
          SlackChannelSettings,
          "connectionId" | "enabled" | "status" | "lastError" | "lastDeliveryError"
        >
      >
    | "loading"
    | "failed"
    | "unavailable";
  /** The latest pushed Slack status, newer than the snapshot for the connection it names. */
  readonly slackLive: SlackChannelStatusEvent | null;
  readonly canConfigureSlack: boolean;
  readonly now: number;
}

/** Whether the bot can work right now, and why not, as lines with at most one fix each. */
export function diagnoseGoatBot(
  input: GoatBotDiagnosticsInput,
  messages: GoatBotDiagnosticMessages = englishDiagnosticMessages,
): GoatBotDiagnostics {
  const homeId = input.home.state === "claimed" ? input.home.claim.environmentId : null;
  // Model, work and Slack would be read from the computer that refused this device.
  if (input.home.state === "claimed" && input.homeRefused === true && !input.home.homeConnected) {
    const text = messages.homeRefused(input.homeLabel);
    return {
      verdict: "down",
      title: messages.down,
      lines: [{ key: "home", tone: "error", text, action: moveAction(input, messages) }],
    };
  }
  const lines = [
    homeLine(input, messages),
    modelLine(input, homeId, messages),
    workLine(input.rows, input.turnsWaiting, messages),
    input.member ? null : slackLine(input, homeId, messages),
  ].filter((line) => line !== null);
  const has = (tone: GoatBotDiagnosticTone) => lines.some((line) => line.tone === tone);
  if (has("error")) return { verdict: "down", title: messages.down, lines };
  if (has("warn")) return { verdict: "attention", title: messages.attention, lines };
  if (has("pending")) return { verdict: "checking", title: messages.checking, lines };
  return { verdict: "ready", title: messages.ready, lines };
}

function moveAction(
  input: GoatBotDiagnosticsInput,
  messages: GoatBotDiagnosticMessages,
): GoatBotDiagnosticAction | null {
  return input.moveTarget === null
    ? null
    : {
        kind: "claim_home",
        environmentId: input.moveTarget.environmentId,
        label: messages.moveHome(input.moveTarget.label),
      };
}

function homeLine(
  input: GoatBotDiagnosticsInput,
  messages: GoatBotDiagnosticMessages,
): GoatBotDiagnosticLine {
  const line = (
    tone: GoatBotDiagnosticTone,
    text: string,
    action: GoatBotDiagnosticAction | null = null,
  ) => ({ key: "home", tone, text, action }) as const;
  switch (input.home.state) {
    case "unknown":
      return line("pending", messages.checkingHome);
    case "unclaimed":
      return line("pending", messages.choosingHome);
    case "claimed": {
      const move = moveAction(input, messages);
      if (!input.home.homeConnected) return line("error", messages.offline(input.homeLabel), move);
      if (!input.home.homeSupportsBot)
        return line("error", messages.unsupported(input.homeLabel), move);
      return line("ok", messages.home(input.homeLabel));
    }
  }
}

function modelLine(
  input: GoatBotDiagnosticsInput,
  homeId: EnvironmentId | null,
  messages: GoatBotDiagnosticMessages,
): GoatBotDiagnosticLine {
  const { model } = input;
  if (model === null)
    return { key: "model", tone: "pending", text: messages.checkingModel, action: null };
  const name = model.provider === null ? model.model : messages.model(model.model, model.provider);
  if (model.available)
    return {
      key: "model",
      tone: "ok",
      text: model.inherited ? messages.inherited(input.mainBotName, name) : name,
      action: null,
    };
  // A member's own model is chosen when it is created; an inherited one changes with GOAT Bot's.
  const fixable = input.canChangeModel && homeId !== null && (!input.member || model.inherited);
  return {
    key: "model",
    tone: "error",
    text: messages.unavailable(model.model),
    action: fixable
      ? { kind: "choose_model", environmentId: homeId, label: messages.chooseModel }
      : null,
  };
}

/**
 * The bot's own turns that ask the person a question, from the newest chip of each task in its
 * conversation. The task list shows a turn only while work it launched still runs, so the chat is
 * where such a question is always found.
 */
export function goatBotTurnsWaiting(
  items: ReadonlyArray<GoatBotFaceTaskItem>,
): ReadonlyArray<GoatBotWaitingTurn> {
  const newest = new Map<string, ChannelTaskChip>();
  for (const { item } of items) {
    if (item.type !== "notification" || item.ledgerTask === undefined) continue;
    const previous = newest.get(item.ledgerTask.taskId);
    if (previous === undefined || item.ledgerTask.taskVersion > previous.taskVersion)
      newest.set(item.ledgerTask.taskId, item.ledgerTask);
  }
  const waiting: Array<{ readonly taskId: string; readonly kind: "approval" | "answer" }> = [];
  for (const chip of newest.values()) {
    // Older chips lack their kind, but a turn's worker is always the bot's session thread.
    const turn =
      chip.kind === "turn" ||
      (chip.kind === undefined &&
        chip.worker !== undefined &&
        isGoatBotSessionThreadId(chip.worker.threadId));
    if (!turn || isChannelTaskTerminal(chip.status)) continue;
    // Its own question, or one in work it launched that the server lifted onto it.
    if (
      (chip.status === "waiting_input" && chip.openQuestionCount > 0) ||
      (chip.observed?.needsYou.length ?? 0) > 0
    ) {
      waiting.push({
        taskId: chip.taskId,
        kind: chip.observed?.needsYou.some((item) => item.kind === "approval")
          ? "approval"
          : "answer",
      });
    }
  }
  return waiting;
}

/** A turn the chat is waiting on. A plain id, from an older caller, counts as an answer. */
export type GoatBotWaitingTurn =
  | string
  | { readonly taskId: string; readonly kind: "approval" | "answer" };

const waitingTurnId = (turn: GoatBotWaitingTurn): string =>
  typeof turn === "string" ? turn : turn.taskId;

const waitingTurnKind = (turn: GoatBotWaitingTurn): "approval" | "answer" =>
  typeof turn === "string" || turn.kind !== "approval" ? "answer" : "approval";

function waitingPhrase(
  approvals: number,
  answers: number,
  messages: GoatBotDiagnosticMessages,
): string | null {
  const parts = [
    approvals > 0 ? messages.approvals(approvals) : null,
    answers > 0 ? messages.answers(answers) : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** Waiting turns the task list does not already show as task rows, so none is counted twice. */
export function goatBotTurnsOutsideList<T extends GoatBotWaitingTurn>(
  turns: ReadonlyArray<T>,
  rows: ReadonlyArray<BotThreadRow>,
): ReadonlyArray<T> {
  const listed = new Set<string>(
    rows.flatMap((row) => (row.kind === "task" ? [row.task.taskId] : [])),
  );
  return turns.filter((turn) => !listed.has(waitingTurnId(turn)));
}

/** The line that points the person back to a question the bot asked in its chat. */
export function goatBotWaitingInChatText(botName: string): string {
  return botName + " is waiting for your answer in the chat";
}

function workLine(
  rows: GoatBotDiagnosticsInput["rows"],
  turnsWaiting: ReadonlyArray<GoatBotWaitingTurn>,
  messages: GoatBotDiagnosticMessages,
): GoatBotDiagnosticLine | null {
  const outside = Array.isArray(rows) ? goatBotTurnsOutsideList(turnsWaiting, rows) : turnsWaiting;
  let approvals = 0;
  let turnAnswers = 0;
  for (const turn of outside) {
    if (waitingTurnKind(turn) === "approval") approvals += 1;
    else turnAnswers += 1;
  }
  const turnsOutside = outside.length;
  // A question in the chat is known without the task list, so it shows whatever the list's state.
  if (!Array.isArray(rows) && turnsOutside > 0)
    return {
      key: "work",
      tone: "warn",
      text: waitingPhrase(approvals, turnAnswers, messages) ?? messages.answers(turnsOutside),
      action: { kind: "open_chat", label: messages.openChat },
    };
  if (rows === "unavailable") return null;
  if (rows === "failed")
    return { key: "work", tone: "warn", text: messages.loadFailed, action: null };
  if (rows === null)
    return { key: "work", tone: "pending", text: messages.loadingWork, action: null };
  const tasks = rows.flatMap((row) => (row.kind === "task" ? [row.task] : []));
  // Listed rows stay an answer. Only a turn the list leaves out can name an approval.
  const waitingIds = new Set(turnsWaiting.map(waitingTurnId));
  const running = tasks.filter(
    (task) => task.status === "running" && !waitingIds.has(task.taskId),
  ).length;
  const starting = tasks.filter(
    (task) => task.status === "received" || task.status === "dispatching",
  ).length;
  const waiting = tasks
    .filter((task) => task.status === "waiting_input" || waitingIds.has(task.taskId))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const parts = [
    running > 0 ? messages.running(running) : null,
    starting > 0 ? messages.queued(starting) : null,
    waitingPhrase(approvals, waiting.length + turnAnswers, messages),
  ].filter((part) => part !== null);
  // A full page can leave older open tasks out, so the counts are only a lower bound.
  const full = tasks.length >= BOT_THREADS_PAGE;
  if (parts.length === 0)
    return full
      ? {
          key: "work",
          tone: "warn",
          text: messages.full(BOT_THREADS_PAGE),
          action: null,
        }
      : { key: "work", tone: "ok", text: messages.noWork, action: null };
  const text = full ? messages.atLeast(parts.join(" · ")) : parts.join(" · ");
  const oldest = waiting[0];
  if (oldest !== undefined)
    return {
      key: "work",
      tone: "warn",
      text,
      action: { kind: "open_task", taskId: oldest.taskId, label: messages.answer },
      ...(turnsOutside > 0
        ? { alsoAction: { kind: "open_chat", label: messages.openChat } as const }
        : {}),
    };
  return turnsOutside > 0
    ? { key: "work", tone: "warn", text, action: { kind: "open_chat", label: messages.openChat } }
    : { key: "work", tone: "ok", text, action: null };
}

function slackLine(
  input: GoatBotDiagnosticsInput,
  homeId: EnvironmentId | null,
  messages: GoatBotDiagnosticMessages,
): GoatBotDiagnosticLine | null {
  if (input.slack === "unavailable") return null;
  if (input.slack === "loading")
    return { key: "slack", tone: "pending", text: messages.checkingSlack, action: null };
  if (input.slack === "failed")
    return { key: "slack", tone: "warn", text: messages.slackCheckFailed, action: null };
  const live = input.slackLive;
  const connections = input.slack
    .filter((connection) => connection.enabled)
    .map((connection) =>
      live === null || live.connectionId !== connection.connectionId
        ? connection
        : {
            ...connection,
            status: live.status,
            lastError: live.lastError,
            lastDeliveryError: live.lastDeliveryError,
          },
    );
  if (connections.length === 0) return null;
  const action: GoatBotDiagnosticAction | null =
    input.canConfigureSlack && homeId !== null
      ? { kind: "open_slack_settings", environmentId: homeId, label: messages.slackSettings }
      : null;
  const failed = connections.find((connection) => connection.status === "error");
  if (failed)
    return {
      key: "slack",
      tone: "error",
      text: messages.slackError(failed.lastError ?? messages.connectionFailed),
      action,
    };
  const joining = connections.find(
    (connection) => connection.status === "connecting" || connection.status === "reconnecting",
  );
  if (joining)
    return {
      key: "slack",
      tone: "pending",
      text: joining.status === "connecting" ? messages.slackConnecting : messages.slackReconnecting,
      action: null,
    };
  const delivery = connections.find(
    (connection) =>
      connection.lastDeliveryError !== undefined &&
      input.now - Date.parse(connection.lastDeliveryError.at) < SLACK_DELIVERY_ERROR_WINDOW_MS,
  )?.lastDeliveryError;
  if (delivery)
    return {
      key: "slack",
      tone: "warn",
      text: messages.deliveryFailed(delivery.code),
      action,
    };
  return { key: "slack", tone: "ok", text: messages.slackConnected, action: null };
}
