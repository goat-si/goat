import { ProviderInstanceId } from "./providerInstance.ts";
import * as Schema from "effect/Schema";
import { EnvironmentId, ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";

export const HandoffKind = Schema.Literals([
  "oauth",
  "device_code",
  "terminal",
  "secret",
  "approval",
  "mfa",
]);
export type HandoffKind = typeof HandoffKind.Type;
export const HandoffState = Schema.Literals([
  "pending",
  "opened",
  "completed",
  "declined",
  "expired",
  "cancelled",
  "failed",
]);
export type HandoffState = typeof HandoffState.Type;
export const HandoffActor = Schema.Union([
  Schema.Struct({ type: Schema.Literal("agent"), threadId: ThreadId }),
  Schema.Struct({ type: Schema.Literal("client"), label: TrimmedNonEmptyString }),
  Schema.Struct({ type: Schema.Literal("server") }),
]);
export type HandoffActor = typeof HandoffActor.Type;

/** Safe to persist in the event log. Human instructions and continuation arguments live separately. */
export const Handoff = Schema.Struct({
  handoffId: TurnItemId,
  kind: HandoffKind,
  title: TrimmedNonEmptyString,
  reason: Schema.String,
  requestedBy: Schema.Struct({
    threadId: ThreadId,
    providerInstanceId: ProviderInstanceId,
    path: TrimmedNonEmptyString,
  }),
  target: Schema.Struct({ environmentId: EnvironmentId, path: TrimmedNonEmptyString }),
  dedupeKey: Schema.String,
  state: HandoffState,
  expiresAt: Schema.NullOr(Schema.DateTimeUtc),
  createdAt: Schema.DateTimeUtc,
  resolvedAt: Schema.optional(Schema.DateTimeUtc),
  resolvedBy: Schema.optional(TrimmedNonEmptyString),
  actor: HandoffActor,
});
export type Handoff = typeof Handoff.Type;

export const HandoffSummary = Schema.Struct({
  handoffId: TurnItemId,
  kind: HandoffKind,
  title: TrimmedNonEmptyString,
  state: HandoffState,
  expiresAt: Schema.NullOr(Schema.DateTimeUtc),
  targetPath: TrimmedNonEmptyString,
});
export type HandoffSummary = typeof HandoffSummary.Type;
export const handoffSummary = (record: Handoff): HandoffSummary => ({
  handoffId: record.handoffId,
  kind: record.kind,
  title: record.title,
  state: record.state,
  expiresAt: record.expiresAt,
  targetPath: record.target.path,
});
export const isHandoffPending = (state: HandoffState) => state === "pending" || state === "opened";
const PROVIDER_SETTINGS_HANDOFF_PATHS: ReadonlySet<string> = new Set([
  "provider.home_request",
  "provider.host_sync",
  "provider.settings",
  "provider.setup",
]);
/**
 * Handoffs a person resolves by changing this environment's providers: they
 * belong to their origin environment and expire on a clock, since the person
 * often finishes after the requesting turn ends.
 */
export const isProviderHandoffPath = (path: string) => PROVIDER_SETTINGS_HANDOFF_PATHS.has(path);

/**
 * An unattended thread's request to use this host's screen. Approving it is admission for the
 * thread until the handoff's expiry, not approval of each action; ending it early moves the
 * approved handoff to cancelled. Like provider handoffs it expires on a clock, because the
 * person usually answers after the bot or scheduled turn that asked has ended.
 */
export const COMPUTER_USE_GRANT_HANDOFF_PATH = "computer_use.grant";

/**
 * A person approving a hub membership change. The asking turn has usually ended, so these run
 * on a clock; the agent continues with the same tool, passing the handoff id as its decisionId.
 */
export const HUB_DEVICE_HANDOFF_PATHS = {
  join: "hub.device_join",
  leave: "hub.device_leave",
  repair: "hub.device_repair",
} as const;
const HUB_PATHS: ReadonlySet<string> = new Set(Object.values(HUB_DEVICE_HANDOFF_PATHS));
export const isHubDeviceHandoffPath = (path: string) => HUB_PATHS.has(path);

/** Handoffs that expire on their clock instead of when the requesting run ends. */
export const isClockedHandoffPath = (path: string) =>
  isProviderHandoffPath(path) ||
  path === COMPUTER_USE_GRANT_HANDOFF_PATH ||
  isHubDeviceHandoffPath(path);

/**
 * Steps that end with the run that asked: a secret card, whose caller collects it in that run,
 * and approvals that are neither SSH nor clocked.
 */
export const endsWithItsRun = (handoff: Pick<Handoff, "kind" | "target">) =>
  handoff.kind === "secret" ||
  (handoff.kind === "approval" &&
    !handoff.target.path.startsWith("ssh.") &&
    !isClockedHandoffPath(handoff.target.path));

/** When an approved computer use admission ends (epoch ms), while it still lasts; else null. */
export const computerUseGrantLiveUntil = (
  handoff: Pick<Handoff, "state" | "expiresAt" | "target">,
  nowMillis: number,
): number | null =>
  handoff.target.path === COMPUTER_USE_GRANT_HANDOFF_PATH &&
  handoff.state === "completed" &&
  handoff.expiresAt !== null &&
  handoff.expiresAt.epochMilliseconds > nowMillis
    ? handoff.expiresAt.epochMilliseconds
    : null;

/** Returned only through authenticated client RPC, never a thread projection or MCP result. */
export const HandoffHuman = Schema.Struct({
  location: TrimmedNonEmptyString,
  fingerprint: Schema.optional(TrimmedNonEmptyString),
  url: Schema.optional(TrimmedNonEmptyString),
  userCode: Schema.optional(TrimmedNonEmptyString),
  command: Schema.optional(TrimmedNonEmptyString),
  /** For `provider.setup`: what the add-provider popup preselects. */
  providerSetup: Schema.optional(
    Schema.Struct({
      driver: Schema.optional(TrimmedNonEmptyString),
      instanceId: Schema.optional(ProviderInstanceId),
    }),
  ),
});
export type HandoffHuman = typeof HandoffHuman.Type;
export const HandoffReadInput = Schema.Struct({ threadId: ThreadId, handoffId: TurnItemId });
export type HandoffReadInput = typeof HandoffReadInput.Type;
export const HandoffRespondInput = Schema.Struct({
  ...HandoffReadInput.fields,
  action: Schema.Literals(["opened", "completed", "declined", "cancelled"]),
});
export type HandoffRespondInput = typeof HandoffRespondInput.Type;
export const HandoffOpenResult = Schema.Struct({
  handoff: Handoff,
  human: Schema.NullOr(HandoffHuman),
});

export const HandoffErrorReason = Schema.Literals([
  "not_found",
  "expired",
  "conflict",
  "unavailable",
  "limit_reached",
  "invalid_request",
]);
export type HandoffErrorReason = typeof HandoffErrorReason.Type;

export class HandoffError extends Schema.TaggedError<HandoffError>()("HandoffError", {
  reason: HandoffErrorReason,
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message() {
    return {
      not_found: "This handoff no longer exists.",
      expired: "This handoff expired. Ask for a new one.",
      conflict: "This handoff can no longer accept that action.",
      unavailable: "Could not update the handoff. Try again.",
      limit_reached: "This thread already has three pending handoffs.",
      invalid_request: "This handoff request is not valid.",
    }[this.reason];
  }
}

export const HandoffJson = Handoff.mapFields((fields) => ({
  ...fields,
  expiresAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  createdAt: Schema.DateTimeUtcFromString,
  resolvedAt: Schema.optional(Schema.DateTimeUtcFromString),
}));
