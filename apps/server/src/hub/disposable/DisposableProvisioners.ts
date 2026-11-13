import { AuthSessionId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SessionStore from "../../auth/SessionStore.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { Provisioners } from "./DisposableAttach.ts";

/**
 * A thread provisioner stays alive while it exists, is neither archived nor deleted, and runs in
 * full-access with the default interaction mode, as when it started the attach (design section 4).
 * A person stays alive while their session is active. Anything unreadable is not alive.
 */
export const layer = Layer.effect(
  Provisioners,
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sessions = yield* SessionStore.SessionStore;
    return Provisioners.of({
      alive: Effect.fn("Provisioners.alive")(function* (provisioner) {
        if (provisioner.kind === "person")
          return yield* sessions.readActiveScopes(AuthSessionId.make(provisioner.sessionId)).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
        return yield* orchestrator.getThreadProjection(ThreadId.make(provisioner.threadId)).pipe(
          Effect.map(
            ({ thread }) =>
              thread.archivedAt === null &&
              thread.deletedAt === null &&
              thread.runtimeMode === "full-access" &&
              thread.interactionMode === "default",
          ),
          Effect.orElseSucceed(() => false),
        );
      }),
    });
  }),
);
