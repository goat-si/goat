/**
 * What a GOAT Bot session is told once, when it starts, frozen in a fixed order so the provider's
 * prompt cache keeps it. Later tasks in the same session send only their own message.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a revision is a content hash.
import * as NodeCrypto from "node:crypto";

import { canSeeTask } from "./channelBotRecall.ts";
import type { ChannelRequester, ChannelTask } from "@goat/contracts";
import type { OrchestrationV2ProviderTurnTokenUsage } from "@goat/contracts";
import { type BotIdentity, DEFAULT_BOT_IDENTITY } from "./ChannelBotProfiles.ts";
import { PERSONAL_DATA_RULE } from "./channelWorkerBrief.ts";

export const SESSION_PREFIX_HEADINGS = [
  "Standing instructions",
  "Standing notes",
  "Journal",
  "Recent conversation",
  "Open work",
  "Current message",
] as const;

export const GOAT_BOT_SESSION_RULES = [
  "You are GOAT Bot's working session for one conversation. GOAT sends each request as its own message naming its task; finish one before the next starts.",
  "Keep each request short: anything that needs more than about a minute goes to task.create children, so the next request is not stuck behind it.",
  // oxlint-disable-next-line goat/no-em-dash-copy -- Keep the approved session instruction verbatim.
  "Begin every request with one line, before any tool call, naming your first step — or the whole answer when no work is needed. The person reads that line at once, so never say it again: your final message carries only what the line did not say.",
  PERSONAL_DATA_RULE,
].join("\n");

export interface SessionPrefixParts {
  readonly standing: string;
  readonly notes: string;
  readonly journal: string;
  readonly tail: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly text: string }>;
  readonly openWork: ReadonlyArray<{
    readonly taskId: string;
    readonly title: string;
    readonly status: string;
  }>;
  readonly message: string;
}

// A body line that looks like a heading is escaped, so every heading line in a prefix is GOAT's own.
const section = (heading: string, body: string) =>
  "## " +
  heading +
  "\n" +
  (body.trim() === "" ? "(none)" : body.trim().replace(/^## /gmu, "\\## "));

/** The session's first message, in the fixed order of SESSION_PREFIX_HEADINGS. */
export const frozenSessionPrefix = (parts: SessionPrefixParts) =>
  [
    section(SESSION_PREFIX_HEADINGS[0], parts.standing),
    section(SESSION_PREFIX_HEADINGS[1], parts.notes),
    section(SESSION_PREFIX_HEADINGS[2], parts.journal),
    section(
      SESSION_PREFIX_HEADINGS[3],
      parts.tail
        .map((entry) => (entry.role === "user" ? "Person: " : "GOAT Bot: ") + entry.text)
        .join("\n"),
    ),
    section(
      SESSION_PREFIX_HEADINGS[4],
      parts.openWork
        .map((task) => "- " + task.taskId + ": " + task.title + " (" + task.status + ")")
        .join("\n"),
    ),
    section(SESSION_PREFIX_HEADINGS[5], parts.message),
  ].join("\n\n");

export const sessionContextRevision = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 16);

/**
 * Whether a frozen prefix shows exactly `notes`: its notes heading and the journal heading each
 * appear once as whole lines, in that order, and the text between them is `notes` as
 * frozenSessionPrefix writes it. A prefix frozen before the notes changed, or one whose text
 * imitates a heading, is not current.
 */
export const notesAreCurrent = (prefix: string, notes: string) => {
  const lines = prefix.split("\n");
  const linesOf = (heading: string) =>
    lines.flatMap((line, index) => (line === "## " + heading ? [index] : []));
  const [start, ...moreNotes] = linesOf(SESSION_PREFIX_HEADINGS[1]);
  const [end, ...moreJournals] = linesOf(SESSION_PREFIX_HEADINGS[2]);
  return (
    start !== undefined &&
    end !== undefined &&
    moreNotes.length === 0 &&
    moreJournals.length === 0 &&
    start < end &&
    lines.slice(start, end).join("\n") === section(SESSION_PREFIX_HEADINGS[1], notes) + "\n"
  );
};

/** Room left for the next request's own tokens before the session counts as full. */
export const SESSION_CONTEXT_RESERVE_TOKENS = 8_192;

/**
 * Whether the session should be replaced before its next request: its prompt cache is known to
 * have expired, or its context plus a reserve passes the provider's budget. An unknown expiry or
 * budget never counts, so time alone never rotates a session.
 */
export const sessionRotationDue = (
  usage: OrchestrationV2ProviderTurnTokenUsage | undefined,
  nowMs: number,
): "cache_expired" | "context_budget" | undefined => {
  if (usage === undefined) return undefined;
  const expiresMs =
    usage.promptCacheExpiresAt === undefined ? Number.NaN : Date.parse(usage.promptCacheExpiresAt);
  if (Number.isFinite(expiresMs) && nowMs >= expiresMs) return "cache_expired";
  const budget = usage.autoCompactThreshold ?? usage.maxTokens ?? undefined;
  if (
    budget !== undefined &&
    budget !== null &&
    usage.usedTokens + SESSION_CONTEXT_RESERVE_TOKENS > budget
  )
    return "context_budget";
  return undefined;
};

export const visibleOpenWork = (
  tasks: ReadonlyArray<ChannelTask>,
  current: ChannelTask,
  requester: ChannelRequester,
) =>
  tasks.filter(
    (task) =>
      task.taskId !== current.taskId &&
      task.requester.principalId === requester.principalId &&
      canSeeTask(requester, task, current.conversationId) &&
      (task.status === "received" ||
        task.status === "dispatching" ||
        task.status === "running" ||
        task.status === "waiting_input"),
  );

export const formatOpenWork = (tasks: ReadonlyArray<ChannelTask>) =>
  "Open work in this conversation:\n" +
  (tasks
    .map((task) => "- " + task.taskId + ": " + task.title + " (" + task.status + ")")
    .join("\n") || "(none)");

/** The bot's identity at the head of a session prefix; empty for the default bot, so its prefix is unchanged. */
export const identitySection = (identity: BotIdentity) =>
  identity.name === DEFAULT_BOT_IDENTITY.name && identity.purpose.trim() === ""
    ? ""
    : // JSON strings carry no raw newline, so profile text can never start a line or a heading.
      "## Identity\nThe person named you " +
      JSON.stringify(identity.name) +
      ". Where GOAT's instructions say GOAT Bot, they mean you: introduce yourself by that name.\n" +
      (identity.purpose.trim() === ""
        ? ""
        : "Your purpose, in the person's words (a JSON string): " +
          JSON.stringify(identity.purpose) +
          "\n") +
      "\n";

const STANDING_HEADING = "## " + SESSION_PREFIX_HEADINGS[0] + "\n";

/** Whether a frozen prefix was started with this identity: the text before its first heading line matches exactly. */
export const identityIsCurrent = (prefix: string, identity: BotIdentity) => {
  const at = prefix.startsWith(STANDING_HEADING) ? 0 : prefix.indexOf("\n" + STANDING_HEADING) + 1;
  return (
    (at > 0 || prefix.startsWith(STANDING_HEADING)) &&
    prefix.slice(0, at) === identitySection(identity)
  );
};
