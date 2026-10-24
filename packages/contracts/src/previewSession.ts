/**
 * One preview surface for an agent driving a browser tab or a desktop app (D6, #1135). Both kinds
 * share this schema and the same controls, so web, desktop and mobile render one panel.
 *
 * @module previewSession
 */
import * as Schema from "effect/Schema";

import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ComputerUseRefusalReason } from "./computerUseProtocol.ts";

export const PreviewSessionKind = Schema.Literals(["browser", "desktop"]);
export type PreviewSessionKind = typeof PreviewSessionKind.Type;

export const PreviewSessionPlatform = Schema.Literals(["mac", "windows", "linux"]);
export type PreviewSessionPlatform = typeof PreviewSessionPlatform.Type;

export const PreviewSessionTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("browser"),
    tabId: TrimmedNonEmptyString,
    url: Schema.String,
    title: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("desktop"),
    /** Filled in once the helper reports the window an agent last acted on. */
    bundleId: Schema.optionalKey(TrimmedNonEmptyString),
    pid: Schema.optionalKey(Schema.Int),
    windowId: Schema.optionalKey(Schema.Int),
    title: Schema.String,
  }),
]);
export type PreviewSessionTarget = typeof PreviewSessionTarget.Type;

/** private: a password, one-time code or passkey prompt has focus; nobody but its person sees it. */
export const PreviewSessionOwner = Schema.Literals(["agent", "human", "private"]);
export type PreviewSessionOwner = typeof PreviewSessionOwner.Type;

export const PreviewSessionStatus = Schema.Literals([
  "idle",
  "observing",
  "acting",
  "waiting-for-human",
  "paused",
  "stopped",
  "error",
  "permission-needed",
]);
export type PreviewSessionStatus = typeof PreviewSessionStatus.Type;

export const PreviewSessionLease = Schema.Struct({
  threadId: ThreadId,
  expiresAt: Schema.String,
  /** The apps the agent may control; absent for the whole screen or a browser tab. */
  scope: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
});
export type PreviewSessionLease = typeof PreviewSessionLease.Type;

export const PreviewSessionControl = Schema.Literals([
  "takeover",
  "handBack",
  "requestHandoff",
  "stop",
  "stopAll",
]);
export type PreviewSessionControl = typeof PreviewSessionControl.Type;

export const PreviewSessionCapabilities = Schema.Struct({
  /** Controls a person can use on this session now, in the order clients show them. */
  controls: Schema.Array(PreviewSessionControl),
  /** Whether a live picture exists: the browser stream, or desktop frames once the helper sends them. */
  frames: Schema.Boolean,
  privateMode: Schema.Boolean,
});
export type PreviewSessionCapabilities = typeof PreviewSessionCapabilities.Type;

export const PreviewSession = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: PreviewSessionKind,
  environmentId: EnvironmentId,
  host: Schema.String,
  platform: PreviewSessionPlatform,
  /** The thread whose agent drives it. */
  threadId: Schema.optionalKey(ThreadId),
  target: PreviewSessionTarget,
  owner: PreviewSessionOwner,
  status: PreviewSessionStatus,
  /** Why the agent cannot act now, when it cannot. */
  reason: Schema.optionalKey(ComputerUseRefusalReason),
  /** What the agent said it needs from a person, after requestHandoff. */
  handoffReason: Schema.optionalKey(Schema.String),
  lease: Schema.optionalKey(PreviewSessionLease),
  /** An asset id for the latest frame; clients load it lazily. */
  lastFrame: Schema.optionalKey(TrimmedNonEmptyString),
  capabilities: PreviewSessionCapabilities,
});
export type PreviewSession = typeof PreviewSession.Type;

export const PreviewSessionsSnapshot = Schema.Struct({
  sessions: Schema.Array(PreviewSession),
});
export type PreviewSessionsSnapshot = typeof PreviewSessionsSnapshot.Type;

export const PreviewSessionControlInput = Schema.Struct({
  /** Ignored for stopAll, which acts on every session on the host. */
  sessionId: Schema.optionalKey(TrimmedNonEmptyString),
  control: PreviewSessionControl,
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
});
export type PreviewSessionControlInput = typeof PreviewSessionControlInput.Type;

export const PreviewSessionControlResult = Schema.Struct({
  applied: Schema.Boolean,
  /** Why a control did nothing: the session is gone, or the control does not fit it now. */
  reason: Schema.optionalKey(Schema.Literals(["not_found", "unsupported", "not_allowed"])),
});
export type PreviewSessionControlResult = typeof PreviewSessionControlResult.Type;

/** The chip every client shows for a session, so the words match everywhere. */
export const previewSessionChip = (session: Pick<PreviewSession, "owner" | "status">) => {
  if (session.owner === "private") return "Private (paused)" as const;
  if (session.status === "permission-needed") return "Permission needed" as const;
  if (session.status === "stopped") return "Stopped" as const;
  if (session.owner === "human") return "You're controlling" as const;
  if (session.status === "waiting-for-human" || session.status === "paused")
    return "Waiting for you" as const;
  return "Agent controlling" as const;
};
