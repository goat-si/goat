import {
  AuthSessionId,
  type ChildReadyFailureCode,
  type ChildReadyPrepareInput,
  ChildSetupPurpose,
  childSetupPurposeAllowsAction,
  childSetupPurposeIsLive,
  type EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
} from "@goat/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a stable id digest; no secret is hashed.
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Sessions from "../auth/SessionStore.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";

/** The one Codex instance a Home's bootstrap owns on this Child, derived from the Home's id. */
export const bootstrapInstanceId = (home: EnvironmentId) =>
  ProviderInstanceId.make(
    `goat_ocx_${NodeCrypto.createHash("sha256").update(home).digest("hex").slice(0, 24)}`,
  );

const isPurpose = Schema.is(ChildSetupPurpose);
const refused = (reason: ChildReadyFailureCode, message: string) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", reason, message });
const revoked = () =>
  refused("setup_approval_revoked", "The Child setup session is no longer active.");

/**
 * The Child's own checks on a Home's setup purpose. The Home alone decides consent, before
 * issuing each phase and after every call; the Child checks only its signed, live, local session
 * and that the work stays on the Home's bootstrap instance. It never calls the Home.
 */
export const make = (
  environmentId: EnvironmentId,
  sessions: Pick<Sessions.SessionStore["Service"], "readActiveScopes">,
) => {
  const authorize = Effect.fn("ChildSetupAuthority.authorize")(function* (
    input: {
      readonly destinationEnvironmentId: EnvironmentId;
      readonly homeEnvironmentId: EnvironmentId;
      readonly operationId?: string;
      readonly action: ChildReadyPrepareInput["action"] | "status";
    },
    scope: McpInvocationScope,
    instance?: {
      readonly id: ProviderInstanceId;
      readonly bootstrapHomeEnvironmentId?: EnvironmentId;
    },
  ) {
    const purpose = scope.childSetupPurpose;
    if (
      !isPurpose(purpose) ||
      scope.client === undefined ||
      scope.thread !== undefined ||
      scope.reauthorize === undefined
    )
      return yield* refused("permission_denied", "A verified Child setup session is required.");
    if (
      purpose.destinationEnvironmentId !== environmentId ||
      scope.environmentId !== environmentId ||
      input.destinationEnvironmentId !== environmentId ||
      purpose.homeEnvironmentId === environmentId ||
      input.homeEnvironmentId !== purpose.homeEnvironmentId ||
      (input.operationId !== undefined && input.operationId !== purpose.operationId)
    )
      return yield* refused(
        "destination_changed",
        "The setup destination, Home or operation changed.",
      );
    const now = yield* Clock.currentTimeMillis;
    if (now >= purpose.expiresAt)
      return yield* refused("purpose_expired", "A setup step timed out. Retry setup.");
    if (!childSetupPurposeIsLive(purpose, now))
      return yield* refused("permission_denied", "The signed setup purpose is invalid.");
    if (now >= purpose.phaseDeadline)
      return yield* refused("phase_timeout", "A setup step timed out. Retry setup.");
    const active = yield* sessions
      .readActiveScopes(AuthSessionId.make(scope.client.sessionId))
      .pipe(Effect.mapError(revoked));
    if (active.length !== 1 || active[0] !== "orchestration:read")
      return yield* refused("permission_denied", "Child setup sessions hold only read scope.");
    yield* scope.reauthorize([]).pipe(Effect.mapError(revoked));
    if (!childSetupPurposeAllowsAction(purpose, input.action))
      return yield* refused("permission_denied", "This phase does not allow that setup action.");
    const instanceId = bootstrapInstanceId(purpose.homeEnvironmentId);
    if (
      instance !== undefined &&
      (instance.id !== instanceId ||
        instance.bootstrapHomeEnvironmentId !== purpose.homeEnvironmentId)
    )
      return yield* refused(
        "instance_changed",
        "This instance is not owned by this Home's bootstrap.",
      );
    return { purpose, instanceId };
  });
  return { authorize };
};

export class ChildSetupAuthority extends Context.Service<
  ChildSetupAuthority,
  ReturnType<typeof make>
>()("goat/opencodex/ChildSetupAuthority") {}

export const layer = Layer.effect(
  ChildSetupAuthority,
  Effect.gen(function* () {
    const identity = yield* Environment.ServerEnvironmentIdentity;
    return make(yield* identity.getEnvironmentId, yield* Sessions.SessionStore);
  }),
);
