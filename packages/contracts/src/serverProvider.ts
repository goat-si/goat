// Trimmed excerpt from goat-si/goat origin/dev packages/contracts/src/server.ts
// (ServerProviderAuth, ServerProvider). Kept: the identity, display, install/version and auth fields
// the bot UI needs for the runtime stamp. Dropped (TODO if needed): continuation, setup,
// nativeSessions, runtimePaths, memoryGeneration, codexRoute, homeRoute, availability, models,
// AcpRegistryUrlAuthAction (auth.action).
import * as Schema from "effect/Schema";
import { ForwardCompatibleArray, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { RuntimeMode } from "./runtimeMode.ts";
import {
  ServerProviderAuthStatus,
  ServerProviderState,
  serverProviderCliFields,
} from "./serverProviderState.ts";

export const ServerProviderAuth = Schema.Struct({
  status: ServerProviderAuthStatus,
  type: Schema.optional(TrimmedNonEmptyString),
  label: Schema.optional(TrimmedNonEmptyString),
  email: Schema.optional(TrimmedNonEmptyString),
  canLogout: Schema.optional(Schema.Boolean),
  subscriptionSharing: Schema.optional(Schema.Boolean),
  profileId: Schema.optional(TrimmedNonEmptyString),
  workspaceId: Schema.optional(TrimmedNonEmptyString),
  /** Origin of the custom endpoint the instance sends its requests to. */
  endpoint: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderAuth = typeof ServerProviderAuth.Type;

export const ServerProvider = Schema.Struct({
  executionLocation: Schema.optional(Schema.Literals(["local", "cloud"])),
  // Only instanceId is stable enough for provider routing.
  instanceId: ProviderInstanceId,
  authSourceInstanceId: Schema.optionalKey(ProviderInstanceId),
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  accentColor: Schema.optional(TrimmedNonEmptyString),
  iconUrl: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2_048))),
  badgeLabel: Schema.optional(TrimmedNonEmptyString),
  supportedRuntimeModes: Schema.optional(ForwardCompatibleArray(RuntimeMode)),
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  version: Schema.NullOr(TrimmedNonEmptyString),
  // Version reported by the installed CLI for a local provider with a separate
  // server. Null means unknown; absence keeps legacy snapshots on `version`.
  installedVersion: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  status: ServerProviderState,
  awaitingFirstCheck: Schema.optionalKey(Schema.Literal(true)),
  auth: ServerProviderAuth,
  checkedAt: IsoDateTime,
  message: Schema.optional(TrimmedNonEmptyString),
  ...serverProviderCliFields,
});
export type ServerProvider = typeof ServerProvider.Type;
