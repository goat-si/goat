import {
  AuthSessionId,
  BotId,
  ChannelGatewayError,
  ChannelTaskId,
  EnvironmentId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { SessionStore } from "../auth/SessionStore.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";

const FollowTarget = Schema.Struct({
  ownerId: Schema.String,
  botId: BotId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
});

const Follow = Schema.Struct({
  ...FollowTarget.fields,
  taskId: ChannelTaskId,
  sessionId: AuthSessionId,
  principalId: Schema.String,
  doneMeans: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_000))),
  lastObservation: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_000))),
});
type Follow = typeof Follow.Type;
type FollowTarget = typeof FollowTarget.Type;

const codec = Schema.fromJsonString(Follow);
const encode = Schema.encodeEffect(codec);
const decode = Schema.decodeUnknownEffect(codec);

const prefix = (parts: ReadonlyArray<string>) =>
  "thread-follow:" + parts.map(encodeURIComponent).join(":") + ":";

function followKey(target: FollowTarget) {
  return (
    "thread-follow:" +
    [target.ownerId, target.botId, target.environmentId, target.threadId]
      .map(encodeURIComponent)
      .join(":")
  );
}

export const makeThreadFollows = Effect.fn("ChannelThreadFollows.make")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* AuthSessions.make;
  const live = yield* Effect.serviceOption(SessionStore);

  const mayRead = Effect.fn("ChannelThreadFollows.mayRead")(function* (
    follow: Pick<Follow, "sessionId" | "principalId">,
    write = false,
  ) {
    const session = yield* sessions.getById({ sessionId: follow.sessionId });
    const now = yield* DateTime.now;
    const persisted =
      Option.isSome(session) &&
      session.value.subject === follow.principalId &&
      session.value.principalKind === "person" &&
      session.value.revokedAt === null &&
      session.value.expiresAt.epochMilliseconds > now.epochMilliseconds &&
      session.value.scopes.includes("orchestration:read") &&
      (!write || session.value.scopes.includes("orchestration:operate"));
    if (!persisted || Option.isNone(session)) return false;
    if (Option.isNone(live)) {
      return (
        session.value.penBinding === null &&
        session.value.penMemberNode === null &&
        session.value.connectAccessGeneration == null
      );
    }
    return yield* live.value.readActiveScopes(follow.sessionId).pipe(
      Effect.map(
        (scopes) =>
          scopes.includes("orchestration:read") &&
          (!write || scopes.includes("orchestration:operate")),
      ),
      Effect.orElseSucceed(() => false),
    );
  });

  const start = Effect.fn("ChannelThreadFollows.start")(function* (follow: Follow) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        if (!(yield* mayRead(follow, true)))
          return yield* new ChannelGatewayError({ reason: "forbidden" });
        const range = prefix([follow.ownerId, follow.botId]);
        const [capacity] = yield* sql<{ count: number; duplicate: number }>`
          SELECT count(*) AS count, coalesce(max(key = ${followKey(follow)}), 0) AS duplicate
          FROM channel_runtime_state WHERE key >= ${range} AND key < ${range.slice(0, -1) + ";"}
        `;
        if (capacity?.duplicate === 1) return false;
        if ((capacity?.count ?? 0) >= 100)
          return yield* new ChannelGatewayError({ reason: "invalid_input" });
        const value = yield* encode(follow);
        const now = DateTime.formatIso(yield* DateTime.now);
        const inserted = yield* sql<{ readonly key: string }>`
      INSERT INTO channel_runtime_state (key, value_json, updated_at)
      VALUES (${followKey(follow)}, ${value}, ${now})
      ON CONFLICT (key) DO NOTHING
      RETURNING key
    `;
        return inserted.length !== 0;
      }),
    );
  });

  const stop = Effect.fn("ChannelThreadFollows.stop")(function* (target: FollowTarget) {
    yield* sql`DELETE FROM channel_runtime_state WHERE key = ${followKey(target)}`;
  });

  // The notice write must use this SQL client so it commits with the observation.
  const settle = Effect.fn("ChannelThreadFollows.settle")(function* <E, R, E2, R2>(
    target: FollowTarget,
    observe: (follow: Follow) => Effect.Effect<string, E, R>,
    writeNotice: (follow: Follow, text: string, accessLost: boolean) => Effect.Effect<void, E2, R2>,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const key = followKey(target);
        const [row] = yield* sql<{ readonly value_json: string }>`
        SELECT value_json FROM channel_runtime_state WHERE key = ${key}
      `;
        if (row === undefined) return;
        const follow = yield* decode(row.value_json);
        if (!(yield* mayRead(follow))) {
          yield* writeNotice(
            follow,
            "Stopped following because the approving session lost access.",
            true,
          );
          yield* stop(target);
          return;
        }
        const observation = yield* observe(follow);
        if (follow.lastObservation === observation) return;
        const value = yield* encode({ ...follow, lastObservation: observation });
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* writeNotice(follow, observation, false);
        yield* sql`
        UPDATE channel_runtime_state SET value_json = ${value}, updated_at = ${now}
        WHERE key = ${key}
      `;
      }),
    );
  });

  const records = Effect.fn("ChannelThreadFollows.records")(function* (lower: string, after = "") {
    const rows = yield* sql<{ key: string; value_json: string }>`
      SELECT key, value_json FROM channel_runtime_state
      WHERE key >= ${lower} AND key < ${lower.slice(0, -1) + ";"} AND key > ${after}
      ORDER BY key LIMIT 100
    `;
    return yield* Effect.forEach(rows, (row) =>
      decode(row.value_json).pipe(Effect.map((follow) => ({ key: row.key, follow }))),
    );
  });

  const list = Effect.fn("ChannelThreadFollows.list")(function* (ownerId: string, botId: BotId) {
    const rows = yield* records(prefix([ownerId, botId]));
    const readable = yield* Effect.filter(rows, ({ follow }) => mayRead(follow));
    return readable.map(({ follow: { environmentId, threadId, taskId, doneMeans } }) => ({
      environmentId,
      threadId,
      taskId,
      ...(doneMeans === undefined ? {} : { doneMeans }),
    }));
  });

  return { start, stop, settle, list, records, mayRead };
});
