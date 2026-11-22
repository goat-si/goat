import { ProviderInputRuntimeMode } from "./channelProviderInputAuthority.ts";
import {
  MAIN_BOT_ID,
  isChannelWorkerThreadId,
  isGoatBotSessionThreadId,
  type MessageId,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type RuntimeMode,
  type ThreadId,
} from "@goat/contracts";
import { makeProviderFailure } from "@goat/provider-core/server/failure";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/sql/SqlClient";
import { DEFAULT_BOT_IDENTITY, readProfileRecord } from "./ChannelBotProfiles.ts";
import { botToolsRefusal } from "./channelBotTools.ts";
import { workerContextOwner } from "./channelProviderBrief.ts";
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

const toolFailure = (profile: typeof DEFAULT_BOT_IDENTITY | undefined, destination: string) => {
  if (profile === undefined) return profileUnreadable;
  const refusal = botToolsRefusal(profile, destination);
  return refusal === undefined
    ? undefined
    : makeProviderFailure({
        class: "validation_error",
        code: "channel_bot_tool_limits",
        message: refusal,
        retryable: false,
      });
};

const channelSessionProfileRefusal = Effect.fn("ChannelBotSession.checkStartProfile")(
  function* (
    sql: SqlClient.SqlClient,
    threadId: ThreadId,
    messageId: MessageId,
    destination: string,
    checkFrozenProfile: boolean,
  ) {
    if (isChannelWorkerThreadId(threadId)) {
      const worker = yield* workerContextOwner(sql, threadId);
      if (worker === undefined) return;
      const [task] = yield* sql<{ readonly owner_id: string; readonly bot_id: string }>`
        SELECT owner_id, bot_id FROM channel_tasks WHERE task_id = ${worker.task_id}
      `;
      if (task === undefined) return profileUnreadable;
      const profile = yield* readProfileRecord(sql, task.owner_id, task.bot_id);
      return toolFailure(
        profile ?? (task.bot_id === MAIN_BOT_ID ? DEFAULT_BOT_IDENTITY : undefined),
        destination,
      );
    }
    if (!isGoatBotSessionThreadId(threadId)) return;
    const [bound] = yield* sql<{ readonly owner_id: string; readonly bot_id: string }>`
      SELECT t.owner_id, t.bot_id
      FROM channel_bot_sessions s JOIN channel_tasks t ON t.task_id = s.task_id
      WHERE s.thread_id = ${threadId}
    `;
    if (bound !== undefined) {
      const profile = yield* readProfileRecord(sql, bound.owner_id, bound.bot_id);
      const failure = toolFailure(
        profile ?? (bound.bot_id === MAIN_BOT_ID ? DEFAULT_BOT_IDENTITY : undefined),
        destination,
      );
      if (failure !== undefined) return failure;
    }
    if (!checkFrozenProfile) return;
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
  if (
    observeOnly ||
    Option.isNone(sql) ||
    !(isGoatBotSessionThreadId(run.threadId) || isChannelWorkerThreadId(run.threadId))
  )
    return;
  return channelSessionProfileRefusal(
    sql.value,
    run.threadId,
    messageId,
    run.providerInstanceId,
    attempt.reason === "initial" &&
      (attempt.inputDelivery === undefined || attempt.inputDelivery === "unsent") &&
      run.startedAt === null,
  );
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
