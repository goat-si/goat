import { MAIN_BOT_ID, type MessageId, type ThreadId } from "@goat/contracts";
import { makeProviderFailure } from "@goat/provider-core/server/failure";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { DEFAULT_BOT_IDENTITY, readProfileRecord } from "./ChannelBotProfiles.ts";
import { PROFILE_UNREADABLE, sessionProfileIsCurrent } from "./channelBotSessionRotation.ts";

export const CHANNEL_SESSION_PROFILE_CHANGED = "channel_session_profile_changed";
export const CHANNEL_SESSION_PROFILE_UNREADABLE = "channel_session_profile_unreadable";

const profileChanged = makeProviderFailure({
  class: "validation_error",
  code: CHANNEL_SESSION_PROFILE_CHANGED,
  message: "The GOAT Bot profile changed before this turn could start.",
  retryable: false,
});
const profileUnreadable = makeProviderFailure({
  class: "validation_error",
  code: CHANNEL_SESSION_PROFILE_UNREADABLE,
  message: PROFILE_UNREADABLE,
  retryable: false,
});

export const channelSessionProfileRefusal = Effect.fn("ChannelBotSession.checkStartProfile")(
  function* (sql: SqlClient.SqlClient, threadId: ThreadId, messageId: MessageId) {
    const [session] = yield* sql<{
      readonly context_text: string | null;
      readonly owner_id: string;
      readonly bot_id: string;
    }>`
      SELECT s.context_text, t.owner_id, t.bot_id
      FROM channel_bot_session_runs r
      JOIN channel_bot_sessions s ON s.thread_id = r.thread_id
      JOIN channel_tasks t ON t.task_id = r.task_id AND t.generation = r.task_generation
      WHERE r.thread_id = ${threadId} AND r.message_id = ${messageId}
        AND r.kind IN ('launch', 'task')
    `;
    if (session === undefined) return;
    const profile = yield* readProfileRecord(sql, session.owner_id, session.bot_id);
    const identity = profile ?? (session.bot_id === MAIN_BOT_ID ? DEFAULT_BOT_IDENTITY : undefined);
    if (identity === undefined) return profileUnreadable;
    if (!sessionProfileIsCurrent(session.context_text, identity)) return profileChanged;
  },
  (effect, _sql, threadId) =>
    effect.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not verify the GOAT Bot session profile", {
          threadId,
          cause,
        }).pipe(Effect.as(profileUnreadable)),
      ),
    ),
);
