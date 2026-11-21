import type { MemoryTaskGrantCeiling, ScheduledTaskListResult } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { SessionStore, VerifiedSession } from "../auth/SessionStore.ts";
import type { RoutineOwner } from "./scheduledBotRoutines.ts";

export const makeScheduledTaskRpcAccess = (
  session: Pick<VerifiedSession, "sessionId" | "scopes" | "principalKind">,
  channelOwner: RoutineOwner,
  sessions: SessionStore["Service"],
) => {
  const owner = sessions.readActiveScopes(session.sessionId).pipe(
    Effect.map((scopes): RoutineOwner | undefined =>
      session.principalKind === "person"
        ? {
            principalId: channelOwner.principalId,
            grantedScopes: scopes,
            sessionId: session.sessionId,
          }
        : undefined,
    ),
    Effect.orElseSucceed(() => undefined),
  );

  return {
    owner,
    capture: <E, R>(ceiling: Effect.Effect<MemoryTaskGrantCeiling, E, R>) =>
      Effect.all({ memoryGrantCeiling: ceiling, owner }).pipe(
        Effect.map(({ memoryGrantCeiling, owner }) => ({
          memoryGrantCeiling,
          ...(owner === undefined ? {} : { owner }),
        })),
      ),
    visibleUrls: (result: ScheduledTaskListResult) =>
      owner.pipe(
        Effect.map((person) => ({
          ...result,
          tasks: result.tasks.map((task) => {
            const permitted =
              task.routineMode === "work"
                ? person?.grantedScopes.includes("settings:write") === true &&
                  person.grantedScopes.includes("orchestration:operate")
                : session.scopes.includes("orchestration:operate");
            if (permitted || task.webhook === undefined) return task;
            const { webhook: _webhook, ...visible } = task;
            return visible;
          }),
        })),
      ),
  };
};
