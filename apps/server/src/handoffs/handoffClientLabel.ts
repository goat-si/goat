import {
  AuthSessionId,
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  EnvironmentAuthorizationError,
  HandoffError,
  STORAGE_CLEAN_HANDOFF_PATH,
  isClockedHandoffPath,
  isHubDeviceHandoffPath,
  type Handoff,
  type HandoffReadInput,
  type HandoffRespondInput,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Environment from "../environment/ServerEnvironment.ts";
import type * as SessionStore from "../auth/SessionStore.ts";
import { canResolveHumanStep, sessionResolver } from "./HumanStepAuthority.ts";

const unavailable = (cause: unknown) => new HandoffError({ reason: "unavailable", cause });
export const makeHandoffClientLabel = ({
  read,
  environment,
  sessions,
}: {
  read: (input: HandoffReadInput) => Effect.Effect<Handoff, HandoffError>;
  environment: Option.Option<Environment.ServerEnvironment["Service"]>;
  sessions: SessionStore.SessionStore["Service"];
}) => {
  return Effect.fn("Handoffs.clientLabel")(function* (
    input: HandoffReadInput & { readonly action?: HandoffRespondInput["action"] },
    sessionId: AuthSessionId,
  ) {
    const record = yield* read(input);
    // Host-bound requests are answered on the environment they would change.
    if (record.target.path.startsWith("ssh.") || isClockedHandoffPath(record.target.path)) {
      if (Option.isNone(environment)) return yield* new HandoffError({ reason: "unavailable" });
      const origin = yield* environment.value.getEnvironmentId;
      if (record.target.environmentId !== origin)
        return yield* new HandoffError({ reason: "invalid_request" });
    }
    const targetScope =
      record.target.path === "ssh.host_add" || record.target.path === "ssh.host_forget"
        ? ("settings:write" as const)
        : record.target.path.startsWith("ssh.")
          ? ("environment:maintain" as const)
          : record.target.path.startsWith("provider.")
            ? ("providers:manage" as const)
            : // Approving a storage deletion is the deletion itself, which takes maintenance.
              record.target.path === STORAGE_CLEAN_HANDOFF_PATH && input.action === "completed"
              ? ("environment:maintain" as const)
              : // Admitting an unattended thread to the screen, or changing the hub's members, is as
                // strong as changing this environment's settings. Ending a screen grant only narrows
                // what agents may do, so whoever may stop agents can end it (Stop all).
                (record.target.path === COMPUTER_USE_GRANT_HANDOFF_PATH &&
                    input.action !== "cancelled") ||
                  isHubDeviceHandoffPath(record.target.path)
                ? ("settings:write" as const)
                : ("orchestration:operate" as const);
    const active = yield* sessions.listActive().pipe(Effect.mapError(unavailable));
    const session = active.find((session) => session.sessionId === sessionId);
    if (session && !canResolveHumanStep(sessionResolver(session), "person_only"))
      return yield* new EnvironmentAuthorizationError({
        requiredScope: "orchestration:operate",
        message: "Only a person's client can act on this handoff.",
      });
    for (const requiredScope of new Set(["orchestration:operate" as const, targetScope])) {
      if (!session || !(session.permissions ?? session.scopes).includes(requiredScope))
        return yield* new EnvironmentAuthorizationError({
          requiredScope,
          message: "This client cannot act on this handoff.",
        });
    }
    return session?.client.label ?? "GOAT client";
  });
};
