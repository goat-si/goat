import { AuthSessionId, ThreadId } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SessionStore from "../../auth/SessionStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as Profiles from "../../goatclaw/PermissionProfiles.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import type { Delegation } from "./attachModel.ts";
import { Provisioners } from "./DisposableAttach.ts";

/**
 * A provisioner's grant now (design section 4). A thread holds one while it exists, is neither
 * archived nor deleted, runs full-access in the default interaction mode, and its goatclaw profile
 * allows hub.manage on the machine's pen host. A person holds one while their session is active,
 * with the scopes it has now. Anything unreadable holds none.
 */
export const layer = Layer.effect(
  Provisioners,
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sessions = yield* SessionStore.SessionStore;
    const profiles = yield* Profiles.PermissionProfiles;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    return Provisioners.of({
      grantOf: Effect.fn("Provisioners.grantOf")(function* (provisioner, nodeId) {
        if (provisioner.kind === "person")
          return yield* sessions.readActiveScopes(AuthSessionId.make(provisioner.sessionId)).pipe(
            Effect.map((scopes): Delegation => ({ kind: "person", scopes })),
            Effect.orElseSucceed(() => undefined),
          );
        return yield* Effect.gen(function* () {
          const { thread } = yield* orchestrator.getThreadProjection(
            ThreadId.make(provisioner.threadId),
          );
          if (
            thread.archivedAt !== null ||
            thread.deletedAt !== null ||
            thread.runtimeMode !== "full-access" ||
            thread.interactionMode !== "default"
          )
            return undefined;
          // The thread acts through GOAT's own continuation here, as a fleet goal's owner does.
          const scope: McpInvocationScope = {
            environmentId: (yield* environment.getDescriptor).environmentId,
            capabilities: new Set(["orchestration"] as const),
            issuedAt: yield* Clock.currentTimeMillis,
            requestNamespace: "goat:disposable",
            thread: {
              threadId: thread.id,
              providerSessionId: "goat:disposable",
              providerInstanceId: thread.modelSelection.instanceId,
            },
            client: undefined,
          };
          const checked = yield* profiles.check(scope, "hub.manage", { host: "pen-" + nodeId });
          if (!checked.ok) return undefined;
          const { effective } = checked;
          return {
            kind: "thread",
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            goatclaw: effective.enabled
              ? {
                  capabilities: effective.profile.capabilities,
                  runtimeMode: effective.runtimeMode,
                  hosts: effective.profile.hosts ?? null,
                }
              : null,
          } satisfies Delegation;
        }).pipe(Effect.orElseSucceed(() => undefined));
      }),
    });
  }),
);
