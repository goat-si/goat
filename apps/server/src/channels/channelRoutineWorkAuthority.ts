import { AuthSessionId, type ChannelInputId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as SessionStore from "../auth/SessionStore.ts";
import { decodeRoutinePayload, routineOwnerOf } from "../scheduledTasks/scheduledBotRoutines.ts";
import { ChannelLedgerError } from "./channelLedgerError.ts";

export const makeRoutineWorkAuthority = Effect.fn("channel.makeRoutineWorkAuthority")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* Effect.serviceOption(SessionStore.SessionStore);

  return Effect.fn("channel.routineWorkAuthority")(function* (inputId: ChannelInputId) {
    const [row] = yield* sql<{
      readonly payload_json: string;
      readonly enabled: number | null;
      readonly owner_json: string | null;
      readonly created_at: string | null;
      readonly project_id: string | null;
      readonly thread_id: string | null;
      readonly signed: number;
    }>`
      SELECT l.payload_json, s.enabled, s.owner_json, s.project_id, s.thread_id, s.created_at,
        s.webhook_secret IS NOT NULL AS signed
      FROM scheduled_task_channel_inputs l LEFT JOIN scheduled_tasks s ON s.task_id=l.task_id
      WHERE l.input_id=${inputId}
    `.pipe(
      Effect.mapError(
        (cause) =>
          new ChannelLedgerError({ reason: "persistence", detail: "read trigger grant", cause }),
      ),
    );
    if (row === undefined || row.enabled === null)
      return { error: "The GOAT Bot work trigger was deleted." } as const;
    if (row.enabled !== 1) return { error: "The GOAT Bot work trigger is paused." } as const;
    const payload = yield* decodeRoutinePayload(row.payload_json).pipe(Effect.option);
    const owner = routineOwnerOf(row.owner_json);
    if (
      Option.isNone(payload) ||
      payload.value.routineMode !== "work" ||
      Option.isNone(owner) ||
      owner.value.routineMode !== "work" ||
      row.signed !== 1 ||
      payload.value.taskCreatedAt !== row.created_at ||
      payload.value.projectId !== row.project_id ||
      payload.value.threadId !== row.thread_id ||
      owner.value.principalId !== payload.value.principalId ||
      (owner.value.bindingRevision ?? 0) !== (payload.value.bindingRevision ?? 0) ||
      owner.value.sessionId === undefined ||
      owner.value.sessionId !== payload.value.sessionId
    )
      return { error: "The GOAT Bot work trigger changed after this delivery arrived." } as const;

    const current = Option.isNone(sessions)
      ? []
      : yield* sessions.value
          .readActiveScopes(AuthSessionId.make(owner.value.sessionId))
          .pipe(Effect.orElseSucceed(() => []));
    const scopes = payload.value.grantedScopes.filter(
      (scope) => owner.value.grantedScopes.includes(scope) && current.includes(scope),
    );
    if (
      scopes.length !== payload.value.grantedScopes.length ||
      !scopes.includes("orchestration:operate") ||
      !scopes.includes("settings:write")
    )
      return { error: "The GOAT Bot work trigger owner's grant expired or was revoked." } as const;
    return {
      projectId: payload.value.projectId,
      scopes: scopes.filter(
        (scope) => scope === "orchestration:operate" || scope === "orchestration:read",
      ),
    } as const;
  });
});
