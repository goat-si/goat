import { EnvironmentAuthorizationError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SessionStore from "../auth/SessionStore.ts";
import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import { assertLiveCaller, loadCaller } from "../mcp/threadAccess.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { authorizeSshHost, type SshHostCaller } from "./SshHostAuthorization.ts";

export const prepareRecovery = (host: string) =>
  `Ask a person to open Settings → Connections and press Retry on ${host} (or Update runtime when it offers one)`;

export const make = Effect.gen(function* () {
  const sessions = yield* SessionStore.SessionStore;
  const profiles = yield* Profiles.PermissionProfiles;
  const threads = yield* Threads.ThreadManagementService;
  return Effect.fn("SshHostSetup.authorizePrepare")(function* (
    caller: SshHostCaller,
    host: string,
  ) {
    if (caller.kind !== "mcp" || caller.scope.thread === undefined)
      return yield* authorizeSshHost(sessions, caller, "environment:maintain");
    const scope = caller.scope;
    const denied = (requirement: string) =>
      new EnvironmentAuthorizationError({
        requiredScope: "orchestration:read",
        message: `${requirement} ${prepareRecovery(host)}.`,
      });
    if (scope.readOnly === true || scope.client?.access === "read-only")
      return yield* denied("This caller has read-only access.");
    yield* authorizeSshHost(sessions, caller, "orchestration:read").pipe(
      Effect.mapError((error) => denied(error.message)),
    );
    const live = yield* loadCaller().pipe(
      Effect.provideService(McpInvocationContext, scope),
      Effect.provideService(Threads.ThreadManagementService, threads),
      Effect.mapError((error) => denied(error.message)),
    );
    yield* Effect.gen(function* () {
      yield* assertLiveCaller(live);
    }).pipe(Effect.mapError((error) => denied(error.message)));
    if (live.limits.runtimeMode !== "full-access" || live.limits.interactionMode !== "default")
      return yield* denied(
        "Preparing a host requires runtime mode full-access and interaction mode default.",
      );
    const checked = yield* profiles
      .check(scope, "hub.manage", { host })
      .pipe(Effect.mapError((error) => denied(error.message)));
    if (!checked.ok) return yield* denied(checked.reason);
    if (!checked.effective.enabled)
      return yield* denied(
        "Thread preparation requires an enabled goatclaw permission profile with hub.manage.",
      );
  });
});
