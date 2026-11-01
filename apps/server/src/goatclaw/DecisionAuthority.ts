import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  OrchestratorMcpFailure,
  type AuthEnvironmentScope,
  type EnvironmentId,
  type DecisionItem,
  type PermissionProfile,
  type RuntimeMode,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import {
  PERSON,
  mcpResolver,
  type HumanStep,
  type HumanStepResolver,
} from "../handoffs/HumanStepAuthority.ts";
import { clientRuntimeModeCeiling, type McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Settings from "../serverSettings.ts";
import * as Profiles from "./PermissionProfiles.ts";

/** Client identity is constructed by the authenticated RPC boundary, never decoded from input. */
export type DecisionCaller =
  | { readonly kind: "agent"; readonly scope: McpInvocationScope }
  | {
      readonly kind: "client";
      readonly environmentId: EnvironmentId;
      readonly sessionId: string;
      readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
      readonly reauthorize?: McpInvocationScope["reauthorize"];
    };

const denied = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });
export const scopeOf = (caller: DecisionCaller): McpInvocationScope =>
  caller.kind === "agent"
    ? caller.scope
    : {
        environmentId: caller.environmentId,
        capabilities: new Set(["orchestration"]),
        issuedAt: 0,
        requestNamespace: `decision-client:${caller.sessionId}`,
        thread: undefined,
        client: {
          sessionId: caller.sessionId,
          label: "Decision inbox",
          access: caller.scopes.includes(AuthOrchestrationOperateScope)
            ? "full-access"
            : "read-only",
        },
        grantedScopes: caller.scopes,
        ...(caller.reauthorize === undefined ? {} : { reauthorize: caller.reauthorize }),
      };
export const isOwner = (caller: DecisionCaller) =>
  caller.kind === "client" && caller.scopes.includes(AuthSettingsWriteScope);
export const resolverOf = (caller: DecisionCaller): HumanStepResolver =>
  caller.kind === "client" ? PERSON : mcpResolver(caller.scope);
export const stepOf = (item: DecisionItem): HumanStep =>
  item.pending?.approval === undefined ? "person_only" : "runtime_approval";
export const writeAccess = (caller: DecisionCaller) =>
  caller.kind === "client"
    ? caller.scopes.includes(AuthOrchestrationOperateScope)
      ? Effect.void
      : Effect.fail(denied("Answering decisions requires orchestration:operate."))
    : caller.scope.readOnly === true || caller.scope.client?.access === "read-only"
      ? Effect.fail(denied("This credential is read-only."))
      : Effect.void;

const modes: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];
export const narrowRuntimeMode = (left: RuntimeMode, right: RuntimeMode) =>
  modes.indexOf(left) <= modes.indexOf(right) ? left : right;

/** Profile names are environment-local; every granted dimension must cover the required definition. */
export const dominatesProfile = (held: PermissionProfile, required: PermissionProfile): boolean =>
  required.capabilities.every((capability) => held.capabilities.includes(capability)) &&
  modes.indexOf(held.runtimeModeCeiling) >= modes.indexOf(required.runtimeModeCeiling) &&
  held.maxLanes >= required.maxLanes &&
  (held.hosts === undefined ||
    (required.hosts !== undefined && required.hosts.every((host) => held.hosts?.includes(host)))) &&
  (held.maxTurns === undefined ||
    (required.maxTurns !== undefined && held.maxTurns >= required.maxTurns)) &&
  (held.maxWallClockMs === undefined ||
    (required.maxWallClockMs !== undefined && held.maxWallClockMs >= required.maxWallClockMs));

export const requireProfile = Effect.fn("DecisionInbox.requireProfile")(function* (
  caller: DecisionCaller,
  requiredProfile: string,
  forwarded?: PermissionProfile,
  runtimeMode?: RuntimeMode,
) {
  const profiles = yield* Profiles.PermissionProfiles;
  const settings = yield* Settings.ServerSettingsService;
  const scope = scopeOf(caller);
  const runtime =
    runtimeMode === undefined || scope.thread !== undefined
      ? runtimeMode
      : narrowRuntimeMode(runtimeMode, clientRuntimeModeCeiling(scope.client));
  const effective = yield* profiles.resolve(scope, runtime, forwarded);
  if (isOwner(caller)) return "owner";
  const required = (yield* settings.getSettings.pipe(
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "Decision inbox storage is unavailable.",
        }),
    ),
  )).goatclaw.profiles[requiredProfile];
  if (required === undefined)
    return yield* denied("The decision's required permission profile is unavailable.");
  // Disabled policy retains its stored default profile separately from the actual session ceiling.
  if (
    !dominatesProfile(
      {
        ...effective.profile,
        runtimeModeCeiling: narrowRuntimeMode(
          effective.profile.runtimeModeCeiling,
          effective.runtimeMode,
        ),
      },
      required,
    )
  )
    return yield* denied(`This decision requires permission profile ${requiredProfile}.`);
  return effective.profile.id;
});
