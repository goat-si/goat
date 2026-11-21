import { BotId, MAIN_BOT_ID, type ChannelConversationId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { ChannelIngressContext } from "../ChannelIngressContext.ts";
import {
  DEFAULT_BOT_IDENTITY,
  normalizeBotName,
  readProfileRecord,
  readStoredBotProfiles,
} from "../ChannelBotProfiles.ts";
import { memberBotKey } from "../channelBotLedger.ts";

const main = BotId.make(MAIN_BOT_ID);
const MAX_REACHABLE_NAMES = 12;

const explicitName = (text: string) => /^([^:\r\n]{1,64}):[ \t]+(\S[\s\S]*)$/u.exec(text);

const readyMember = (sql: SqlClient.SqlClient, ownerId: string, botId: BotId) =>
  sql<{ readonly ready: number }>`
    SELECT 1 AS ready FROM channel_runtime_state WHERE key = ${memberBotKey(ownerId, botId)}
  `.pipe(Effect.map((rows) => rows.length > 0));

/** Called within the inbox write transaction, after sender admission and event deduplication. */
export const routeSlackInput = Effect.fn("ChannelLedger.routeSlackInput")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly ownerId: string;
    readonly conversationId: ChannelConversationId;
    readonly slackRouting?: ChannelIngressContext["slackRouting"];
  },
  text: string,
) {
  const { ownerId, conversationId, slackRouting } = input;
  const [conversation] = yield* sql<{ readonly slack_bot_id: string | null }>`
    SELECT slack_bot_id FROM channel_conversations WHERE conversation_id = ${conversationId}
  `;
  if (conversation !== undefined) {
    const pinned = conversation.slack_bot_id;
    if (pinned !== null) {
      const botId = BotId.make(pinned);
      if (botId === main) return { botId, text };
      const profile = yield* readProfileRecord(sql, ownerId, pinned);
      if (profile?.role === "member" && profile.state !== "deleted") return { botId, text };
      const name = profile?.name ?? "This bot";
      return { notice: name + " was deleted. Restore it in GOAT or start a new Slack thread." };
    }

    // Old writers leave the column empty. They may also have stored link rejections only.
    const admitted = yield* sql<{ readonly admitted: number }>`
      SELECT 1 AS admitted FROM channel_inbox
      WHERE conversation_id = ${conversationId} AND state <> 'rejected' LIMIT 1
    `;
    if (admitted.length > 0) return { botId: main, text };
  }

  const bound = slackRouting?.boundBotId ?? main;
  const prefix = slackRouting?.allowName === true ? explicitName(text) : null;
  const name = prefix?.[1]?.trim();
  if (name === undefined && bound === main) return { botId: main, text };

  const stored = yield* readStoredBotProfiles(sql, ownerId);
  const mainName =
    stored.find((profile) => profile.role === "main")?.name ?? DEFAULT_BOT_IDENTITY.name;
  const candidates = [
    { botId: main, name: mainName, hidden: false },
    ...stored.flatMap((profile) =>
      profile.role === "member" && profile.state !== "deleted" ? [profile] : [],
    ),
  ];
  const matches =
    name === undefined
      ? []
      : candidates.filter(
          (candidate) => normalizeBotName(candidate.name) === normalizeBotName(name),
        );
  // Existing messages may start with "do: " as an instruction.
  const named = name !== undefined && (normalizeBotName(name) !== "do" || matches.length > 0);
  const chosen = named
    ? matches.length === 1
      ? matches[0]
      : undefined
    : candidates.find((candidate) => candidate.botId === bound);
  if (
    chosen !== undefined &&
    chosen.hidden !== true &&
    (chosen.botId === main || (yield* readyMember(sql, ownerId, chosen.botId)))
  ) {
    return { botId: chosen.botId, text: named ? (prefix?.[2] ?? text) : text };
  }

  const reachable: string[] = [];
  for (const candidate of candidates) {
    if (
      candidate.hidden === true ||
      candidates.some(
        (other) =>
          other.botId !== candidate.botId &&
          normalizeBotName(other.name) === normalizeBotName(candidate.name),
      )
    )
      continue;
    if (candidate.botId === main || (yield* readyMember(sql, ownerId, candidate.botId))) {
      reachable.push(candidate.name.replace(/\s+/gu, " "));
      if (reachable.length === MAX_REACHABLE_NAMES) break;
    }
  }
  const reason = named
    ? "That bot name is unavailable or ambiguous."
    : "The bot bound to this channel is unavailable.";
  return {
    notice:
      reachable.length === 0 ? reason : reason + " Reachable bots: " + reachable.join(", ") + ".",
  };
});
