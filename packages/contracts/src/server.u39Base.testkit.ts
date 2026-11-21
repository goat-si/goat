import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ForwardCompatibleArray, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RuntimeMode } from "./providerPolicy.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { CodexRouteStatus, ProviderHomeRouteStatus } from "./codexRoute.ts";
import { ServerProviderUsageLimits } from "./providerUsageLimits.ts";
import { ServerProviderState, serverProviderCliFields } from "./serverProviderState.ts";
import {
  ServerProviderContinuation,
  ServerProviderAuth,
  ServerProviderAvailability,
  ServerProviderModel,
  ServerProviderUpdateRequiredModel,
  ServerProviderSlashCommand,
  ServerProviderSkill,
  ServerProviderWorkspaceSnapshot,
  ServerProviderVersionAdvisory,
  ServerProviderCompatibilityAdvisory,
  ServerProviderUpdateState,
} from "./server.ts";

export const ServerProvider = Schema.Struct({
  executionLocation: Schema.optional(Schema.Literals(["local", "cloud"])),
  // Only instanceId is stable enough for provider routing.
  instanceId: ProviderInstanceId,
  authSourceInstanceId: Schema.optionalKey(ProviderInstanceId),
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  accentColor: Schema.optional(TrimmedNonEmptyString),
  // Validate driver-supplied remote icons against the driver's trusted origin.
  iconUrl: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2_048))),
  badgeLabel: Schema.optional(TrimmedNonEmptyString),
  continuation: Schema.optional(ServerProviderContinuation),
  showInteractionModeToggle: Schema.optional(Schema.Boolean),
  reportsContextWindow: Schema.optional(Schema.Boolean),
  supportedRuntimeModes: Schema.optional(ForwardCompatibleArray(RuntimeMode)),
  requiresNewThreadForModelChange: Schema.optional(Schema.Boolean),
  supportsConversationRollback: Schema.optional(Schema.Boolean),
  supportsTextGeneration: Schema.optional(Schema.Boolean),
  supportsStructuredCustomModels: Schema.optionalKey(Schema.Boolean),
  memoryGeneration: Schema.optionalKey(
    Schema.Struct({ summary: Schema.Boolean, conflict: Schema.Boolean }),
  ),
  setup: Schema.optional(
    Schema.Struct({
      canAuthenticate: Schema.Boolean,
      canInstall: Schema.Boolean,
      documentationUrl: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(2_048))),
    }),
  ),
  nativeSessions: Schema.optional(
    Schema.Struct({
      canList: Schema.Boolean,
      canLoad: Schema.Boolean,
      canResume: Schema.Boolean,
      canDelete: Schema.optional(Schema.Boolean),
    }),
  ),
  configurableProviders: Schema.optional(Schema.Boolean),
  runtimePaths: Schema.optionalKey(
    Schema.Struct({
      homePath: TrimmedNonEmptyString,
      shadowHomePath: Schema.NullOr(TrimmedNonEmptyString),
    }),
  ),
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
  codexRoute: Schema.optionalKey(CodexRouteStatus),
  homeRoute: Schema.optionalKey(ProviderHomeRouteStatus),
  availability: Schema.optional(ServerProviderAvailability),
  unavailableReason: Schema.optional(TrimmedNonEmptyString),
  models: Schema.Array(ServerProviderModel),
  // Kept apart from `models` so clients that predate it never offer them.
  updateRequiredModels: Schema.optionalKey(Schema.Array(ServerProviderUpdateRequiredModel)),
  slashCommands: Schema.Array(ServerProviderSlashCommand).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  skills: Schema.Array(ServerProviderSkill).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Digest of the full machine command and skill lists for an on-demand catalog. */
  catalogDigest: Schema.optionalKey(TrimmedNonEmptyString),
  /** The digest whose lists this client has loaded. Stored in the client cache. */
  loadedCatalogDigest: Schema.optionalKey(TrimmedNonEmptyString),
  workspaceSnapshots: Schema.optionalKey(Schema.Array(ServerProviderWorkspaceSnapshot)),
  usageLimits: Schema.optional(ServerProviderUsageLimits),
  versionAdvisory: Schema.optionalKey(ServerProviderVersionAdvisory),
  compatibilityAdvisory: Schema.optionalKey(ServerProviderCompatibilityAdvisory),
  updateState: Schema.optionalKey(ServerProviderUpdateState),
});
