import { ProviderInputRuntimeMode } from "./channelProviderInputAuthority.ts";
import {
  MAIN_BOT_ID,
  isGoatBotSessionThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type MessageId,
  type RuntimeMode,
  type ThreadId,
} from "@goat/contracts";
import { makeProviderFailure } from "@goat/provider-core/server/failure";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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

const channelSessionProfileRefusal = Effect.fn("ChannelBotSession.checkStartProfile")(
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

export function queuedChannelProfileRefusal(
  sql: Option.Option<SqlClient.SqlClient>,
  observeOnly: boolean,
  attempt: OrchestrationV2RunAttempt,
  run: OrchestrationV2Run,
  messageId: MessageId,
) {
  return !observeOnly &&
    attempt.reason === "initial" &&
    (attempt.inputDelivery === undefined || attempt.inputDelivery === "unsent") &&
    run.startedAt === null &&
    isGoatBotSessionThreadId(run.threadId) &&
    Option.isSome(sql)
    ? channelSessionProfileRefusal(sql.value, run.threadId, messageId)
    : undefined;
}

type ProfileRefusal = ReturnType<typeof channelSessionProfileRefusal>;
type AuthorityRefusal = Effect.Effect<
  Effect.Success<ProfileRefusal>,
  never,
  ProviderInputRuntimeMode
>;

export function providerInputFence(
  authority: AuthorityRefusal | undefined,
  profile: ProfileRefusal | undefined,
  mode: RuntimeMode,
) {
  const liveAuthority = authority?.pipe(Effect.provideService(ProviderInputRuntimeMode, mode));
  const refusal =
    liveAuthority !== undefined && profile !== undefined
      ? liveAuthority.pipe(
          Effect.filterOrElse(
            (failure) => failure !== undefined,
            () => profile,
          ),
        )
      : (liveAuthority ?? profile);
  return refusal === undefined ? {} : { providerInputRefusal: refusal };
}
