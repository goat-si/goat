/**
 * channelBotSessionBrief - what a GOAT Bot session is told once, when it starts.
 *
 * The prefix is frozen in a fixed order so the provider's prompt cache keeps it: standing
 * instructions, standing notes, journal, recent conversation, open work, then the message that
 * started the session. Later tasks in the same session send only their own message.
 *
 * @module channelBotSessionBrief
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a revision is a content hash.
import * as NodeCrypto from "node:crypto";

import type { OrchestrationV2ProviderTurnTokenUsage } from "@goat/contracts";

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
  "The person already got a first reply from GOAT naming your first step; do not repeat it.",
].join("\n");

export interface SessionPrefixParts {
  readonly standing: string;
  readonly notes: string;
  readonly journal: string;
  readonly tail: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly text: string }>;
  readonly openWork: ReadonlyArray<{ readonly title: string; readonly status: string }>;
  readonly message: string;
}

const section = (heading: string, body: string) =>
  "## " + heading + "\n" + (body.trim() === "" ? "(none)" : body.trim());

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
      parts.openWork.map((task) => "- " + task.title + " (" + task.status + ")").join("\n"),
    ),
    section(SESSION_PREFIX_HEADINGS[5], parts.message),
  ].join("\n\n");

export const sessionContextRevision = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 16);

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
