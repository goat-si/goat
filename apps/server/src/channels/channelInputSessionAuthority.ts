import type { AuthSessionId, ChannelInputId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as SessionStore from "../auth/SessionStore.ts";

export const makeChannelInputSessionAuthority = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* Effect.serviceOption(SessionStore.SessionStore);
  return Effect.fn("channel.inputSessionScopes")(function* (inputId: ChannelInputId) {
    const rows = yield* sql<{ readonly auth_session_id: AuthSessionId | null }>`
      SELECT auth_session_id FROM channel_inbox WHERE input_id = ${inputId}
    `;
    const sessionId = rows[0]?.auth_session_id;
    if (sessionId == null) return Option.isNone(sessions) ? undefined : [];
    if (Option.isNone(sessions)) return [];
    return yield* sessions.value.readActiveScopes(sessionId).pipe(Effect.orElseSucceed(() => []));
  });
});
