import { GOAT_ORCHESTRATION_PROTOCOL_HEADER } from "@goat/contracts/legacyT3Names";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  ForwardCompatibleOptional,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** Wire version for orchestration snapshots, streams, commands, and RPC payloads.
 * GOAT 1001 <-> upstream 2. GOAT protocol numbers only increase. */
export const ORCHESTRATION_PROTOCOL_VERSION = 1001;
export const ORCHESTRATION_PROTOCOL_VERSION_TEXT = `${ORCHESTRATION_PROTOCOL_VERSION}` as const;
/**
 * Oldest orchestration protocol this server still serves. Clients always speak
 * ORCHESTRATION_PROTOCOL_VERSION; lower this only together with the decoders and behavior that
 * keep the older protocol working, so a newer server keeps older clients connected.
 */
export const ORCHESTRATION_PROTOCOL_MIN_SERVED: number = 1001;

/** Whether this server accepts a client announcing `announced` as its orchestration protocol. */
export function servesOrchestrationProtocol(announced: string | null | undefined): boolean {
  if (announced == null || !/^[1-9][0-9]{0,15}$/u.test(announced)) return false;
  const version = Number(announced);
  return ORCHESTRATION_PROTOCOL_MIN_SERVED <= version && version <= ORCHESTRATION_PROTOCOL_VERSION;
}
export const ORCHESTRATION_PROTOCOL_QUERY_PARAM = "orchestrationProtocol";
export const ORCHESTRATION_PROTOCOL_HEADER = GOAT_ORCHESTRATION_PROTOCOL_HEADER;

export const ExecutionEnvironmentPlatformOs = Schema.Literals([
  "darwin",
  "linux",
  "windows",
  "unknown",
]);
export type ExecutionEnvironmentPlatformOs = typeof ExecutionEnvironmentPlatformOs.Type;

export const ExecutionEnvironmentPlatformArch = Schema.Literals(["arm64", "x64", "other"]);
export type ExecutionEnvironmentPlatformArch = typeof ExecutionEnvironmentPlatformArch.Type;

export const ENVIRONMENT_MACHINE_KINDS = [
  "server",
  "cloud",
  "linux",
  "desktop",
  "laptop",
  "mac-mini",
  "mac-studio",
] as const;
export const EnvironmentMachineKind = Schema.Literals(ENVIRONMENT_MACHINE_KINDS);
export type EnvironmentMachineKind = typeof EnvironmentMachineKind.Type;
export const isEnvironmentMachineKind = Schema.is(EnvironmentMachineKind);

export const ExecutionEnvironmentPlatform = Schema.Struct({
  os: ExecutionEnvironmentPlatformOs,
  arch: ExecutionEnvironmentPlatformArch,
  machine: ForwardCompatibleOptional(EnvironmentMachineKind),
});

/**
 * Lives here (not settings.ts) so orchestration contracts can reference it
 * without an import cycle.
 */
export const ThreadEnvMode = Schema.Literals(["local", "worktree"]);
export type ThreadEnvMode = typeof ThreadEnvMode.Type;

export const WorktreeSubmodules = Schema.Literals(["recursive", "top-level", "none"]);
export type WorktreeSubmodules = typeof WorktreeSubmodules.Type;
export type ExecutionEnvironmentPlatform = typeof ExecutionEnvironmentPlatform.Type;

export const ServerSelfUpdateMethod = Schema.Literals(["boot-service", "respawn", "desktop-app"]);
export type ServerSelfUpdateMethod = typeof ServerSelfUpdateMethod.Type;

export const ServerInstallation = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["npx", "pnpm-dlx", "bunx"]) }),
  Schema.Struct({ kind: Schema.Literal("npm-global"), prefix: TrimmedNonEmptyString }),
]);
export type ServerInstallation = typeof ServerInstallation.Type;

export const ServerSelfUpdateCapability = Schema.Literals([
  "boot-service",
  "respawn",
  "desktop-managed",
]);
export type ServerSelfUpdateCapability = typeof ServerSelfUpdateCapability.Type;

export const ExecutionEnvironmentCapabilities = Schema.Struct({
  memoryHubProtocolVersion: Schema.optionalKey(Schema.Int),
  memory: Schema.optionalKey(
    Schema.Struct({
      protocolVersion: Schema.Int,
      hub: Schema.optionalKey(Schema.Boolean),
      importProvider: Schema.optionalKey(Schema.Boolean),
      /** Import preview can flag items too large for the turn-start frame; absent on older servers. */
      importTurnStartFit: Schema.optionalKey(Schema.Boolean),
      refusedReverts: Schema.optionalKey(Schema.Boolean),
      resolutionInputs: Schema.optionalKey(Schema.Boolean),
      retainedLocalSpace: Schema.optionalKey(Schema.Boolean),
      /** memory.syncStatus may report a paused memory model when the request opts in. */
      generationHold: Schema.optionalKey(Schema.Boolean),
      /** Separate diagnostics/read and Settings reconcile RPCs; absent on older servers. */
      hubDiagnostics: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  repositoryIdentity: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  connectionProbe: Schema.optionalKey(Schema.Boolean),
  attachmentUploads: Schema.optionalKey(Schema.Boolean),
  questionAttachments: Schema.optionalKey(Schema.Boolean),
  fileAttachments: Schema.optionalKey(
    Schema.Struct({
      maxUploadBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    }),
  ),
  pullRequests: Schema.optionalKey(Schema.Boolean),
  pullRequestChecks: Schema.optionalKey(Schema.Boolean),
  /** Absent on servers from before inline context shipped, which drop the records and forward
      the links as literal text -- so a client must serialize context the legacy way for them. */
  inlineMessageContext: Schema.optionalKey(Schema.Boolean),
  requiredWorktreeBootstrap: Schema.optionalKey(Schema.Boolean),
  threadSettlement: Schema.optionalKey(Schema.Boolean),
  threadAutoSettlement: Schema.optionalKey(Schema.Boolean),
  storageCleanup: Schema.optionalKey(Schema.Boolean),
  storageCleanupRun: Schema.optionalKey(Schema.Boolean),
  /** Server streams database size and reclaimable space for the Storage settings notice. */
  databaseStorage: Schema.optionalKey(Schema.Boolean),
  /** Server checks OTLP endpoints for the telemetry export settings. */
  otlpEndpointCheck: Schema.optionalKey(Schema.Boolean),
  projectWorktreeCleanup: Schema.optionalKey(Schema.Boolean),
  settledWorktreeCleanup: Schema.optionalKey(Schema.Boolean),
  worktreesDirectory: Schema.optionalKey(Schema.Boolean),
  /** Server answers `server.getWorktreesDirectoryStatus` and falls back when it is unavailable. */
  worktreesDirectoryStatus: Schema.optionalKey(Schema.Boolean),
  /** Server can exclude PR-linked threads from inactivity settlement. */
  threadAutoSettlementScope: Schema.optionalKey(Schema.Boolean),
  threadRestartContinuation: Schema.optionalKey(Schema.Boolean),
  projectSettingsOverrides: Schema.optionalKey(Schema.Boolean),
  /**
   * Older
      servers decode the key away (unknown fields are stripped, not
      rejected), so the per-project provider switch would silently do
      nothing; clients hide it instead of sending a patch that goes nowhere.
   */
  projectProviderInstanceOverrides: Schema.optionalKey(Schema.Boolean),
  threadSnooze: Schema.optionalKey(Schema.Boolean),
  /** Server understands thread.promote. Same version-skew contract as threadSettlement. */
  threadPromotion: Schema.optionalKey(Schema.Boolean),
  /** Server streams themes an environment publishes. Absent on servers from
      before environment themes shipped, which never emit the events -- so a
      client reconnecting to one must drop published themes rather than keep
      showing a set nothing will ever update. */
  environmentThemes: Schema.optionalKey(Schema.Boolean),
  usageLimitSources: Schema.optionalKey(Schema.Boolean),
  usagePriceOverrides: Schema.optionalKey(Schema.Boolean),
  usageModelAliases: Schema.optionalKey(Schema.Boolean),
  threadPinning: Schema.optionalKey(Schema.Boolean),
  threadPinReorder: Schema.optionalKey(Schema.Boolean),
  threadActiveReorder: Schema.optionalKey(Schema.Boolean),
  threadAutoSettleOptOut: Schema.optionalKey(Schema.Boolean),
  threadTitleRegeneration: Schema.optionalKey(Schema.Boolean),
  threadVisitedTracking: Schema.optionalKey(Schema.Boolean),
  threadPullRequestLinking: Schema.optionalKey(Schema.Boolean),
  serverResolvedCommandContext: Schema.optionalKey(Schema.Boolean),
  threadStop: Schema.optionalKey(Schema.Boolean),
  threadPullRequests: Schema.optionalKey(Schema.Boolean),
  threadPullRequestWatch: Schema.optionalKey(Schema.Boolean),
  pullRequestStackActions: Schema.optionalKey(Schema.Boolean),
  serverSelfUpdate: Schema.optionalKey(ServerSelfUpdateCapability),
  /**
   * Older servers strip the unknown settings key, so the preference would
   * snap back; clients disable the switch unless this is true.
   */
  automaticServerUpdates: Schema.optionalKey(Schema.Boolean),
  /** Manual commands must update this install, not the host's default global prefix. */
  serverInstallation: ForwardCompatibleOptional(ServerInstallation),
  serverSelfUpdateProgress: Schema.optionalKey(Schema.Boolean),
  serverUpdateThreadContinuation: Schema.optionalKey(Schema.Boolean),
  /**
   * Clients skip seeding a Live Activity when
      this is false — no update would ever repaint it. Absent on older
      servers, which may still publish, so only an explicit false skips.
   */
  agentActivityPublishing: Schema.optionalKey(Schema.Boolean),
  projectCloneTracking: Schema.optionalKey(Schema.Boolean),
  /** Server answers projects.listIgnoredFiles. */
  ignoredFileListing: Schema.optionalKey(Schema.Boolean),
  environmentIcon: Schema.optionalKey(Schema.Boolean),
  desktopAppUpdate: Schema.optionalKey(Schema.Boolean),
  /** Server answers orchestration.subscribeCommandOutput. Absent on older servers,
      which never send command output, so clients must not subscribe. */
  commandOutputStreaming: Schema.optionalKey(Schema.Boolean),
  /** Server hosts preview tabs in its own headless Chromium (`runtime:
      "server"`) and streams them over `/api/preview-stream`. Clients
      without a local browser runtime open server tabs here. */
  serverBrowser: Schema.optionalKey(Schema.Boolean),
  /** Server exposes the bounded SSH runtime activity probe. */
  sshActivity: Schema.optionalKey(Schema.Boolean),
  /** Server proxies its nodes' APIs below `/hub/nodes` for clients holding `hub:proxy`. */
  hubProxy: Schema.optionalKey(Schema.Boolean),
  /** Server answers `POST /.well-known/goat/runtime/drain`: it can stop admitting turns, drain,
      and exit on its own for a replacement. Servers without it are attach-only. */
  drainRestart: Schema.optionalKey(Schema.Boolean),
  /** Server runs the channel ledger and the GOAT bot gateway (`channel.*` RPCs). Absent on
      older servers, so clients keep the bot inert instead of sending to a legacy agent. */
  channelLedger: Schema.optionalKey(Schema.Boolean),
  /** Server stores the cluster's GOAT Bot home claim (`goatBotHome` setting) and refuses the bot
      when the claim names another environment. Clients write claims only to servers with this. */
  goatBotHome: Schema.optionalKey(Schema.Boolean),
  /** Server answers `channel.getBotStatus`. Older servers leave clients paging `listTasks`. */
  goatBotStatus: Schema.optionalKey(Schema.Boolean),
  /** `channel.getBotStatus` leaves out tasks that were waiting when the bot thread was last visited. */
  goatBotWaitingRead: Schema.optionalKey(Schema.Boolean),
  /** Server runs a live Slack channel connection. False while only the settings contract exists. */
  slackChannel: Schema.optionalKey(Schema.Boolean),
});
export type ExecutionEnvironmentCapabilities = typeof ExecutionEnvironmentCapabilities.Type;

export const ProtocolRange = Schema.Struct({
  min: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  max: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type ProtocolRange = typeof ProtocolRange.Type;

/** Protocol versions a build speaks. Clients attach when both ranges overlap theirs. */
export const RuntimeProtocolRanges = Schema.Struct({
  ssh: ProtocolRange,
  orchestration: ProtocolRange,
});
export type RuntimeProtocolRanges = typeof RuntimeProtocolRanges.Type;

export const ExecutionEnvironmentDescriptor = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  platform: ExecutionEnvironmentPlatform,
  serverVersion: TrimmedNonEmptyString,
  /** Absent on servers predating SSH runner compatibility advertisement. */
  sshRuntimeProtocolVersion: Schema.optionalKey(Schema.Int),
  /** Absent on hosts from before explicit orchestration protocol negotiation. */
  orchestrationProtocolVersion: Schema.optionalKey(Schema.Int),
  /** Supported protocol ranges. Absent on servers that only advertise the integers above. */
  protocol: Schema.optionalKey(RuntimeProtocolRanges),
  /** New for every server start. A replacement request names it so it never hits a successor. */
  instanceId: Schema.optionalKey(TrimmedNonEmptyString),
  capabilities: ExecutionEnvironmentCapabilities,
});
export type ExecutionEnvironmentDescriptor = typeof ExecutionEnvironmentDescriptor.Type;

export const RepositoryIdentityLocator = Schema.Struct({
  source: Schema.Literal("git-remote"),
  remoteName: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
});
export type RepositoryIdentityLocator = typeof RepositoryIdentityLocator.Type;

export const RepositoryOrigin = Schema.Struct({
  canonicalKey: TrimmedNonEmptyString,
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
});
export type RepositoryOrigin = typeof RepositoryOrigin.Type;

export const RepositoryIdentity = Schema.Struct({
  canonicalKey: TrimmedNonEmptyString,
  locator: RepositoryIdentityLocator,
  webUrl: Schema.optionalKey(TrimmedNonEmptyString),
  /** Work tree root, or the git dir for a bare repository. */
  rootPath: Schema.optionalKey(TrimmedNonEmptyString),
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  provider: Schema.optionalKey(TrimmedNonEmptyString),
  owner: Schema.optionalKey(TrimmedNonEmptyString),
  name: Schema.optionalKey(TrimmedNonEmptyString),
  origin: Schema.optionalKey(RepositoryOrigin),
});
export type RepositoryIdentity = typeof RepositoryIdentity.Type;

export function repositoryGroupingKeyOf(identity: RepositoryIdentity): string {
  return identity.origin?.canonicalKey ?? identity.canonicalKey;
}

export function repositoryGroupingDisplayNameOf(identity: RepositoryIdentity): string | undefined {
  return identity.origin
    ? (identity.origin.displayName ?? identity.origin.canonicalKey)
    : identity.displayName;
}

export const ScopedProjectRef = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
});
export type ScopedProjectRef = typeof ScopedProjectRef.Type;

export const ScopedThreadRef = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type ScopedThreadRef = typeof ScopedThreadRef.Type;

export function supportsMemoryProtocol(capabilities: ExecutionEnvironmentCapabilities): boolean {
  return capabilities.memory?.protocolVersion === 1;
}
