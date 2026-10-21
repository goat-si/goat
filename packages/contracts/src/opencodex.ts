import * as Schema from "effect/Schema";
import { ForwardCompatibleOptional, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { HubParityEvidence } from "./hubParity.ts";

const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));
const Protocol = Schema.Int.check(Schema.isGreaterThan(0));

/** Only metadata served by the runtime, never inferred from its release number. */
export const OpenCodexProtocolEvidence = Schema.Struct({
  protocol: Schema.optional(Protocol),
  minimumClientProtocol: Schema.optional(Protocol),
  protocolVersion: Schema.optional(Protocol),
  relayAuthVersion: Schema.optional(Schema.String),
  features: Schema.optional(Schema.Array(Schema.String)),
});
export type OpenCodexProtocolEvidence = typeof OpenCodexProtocolEvidence.Type;

/**
 * This device's row of OpenCodex's `ocx.fallback/1` view (OCX-11). `source` says where OpenCodex
 * read it: "home" is the Home's policy over the link, "live" this proxy's own, and "local" this
 * machine's config, which says nothing about the Home's permission. Older OpenCodex omits it.
 */
export const OpenCodexDeviceFallback = Schema.Struct({
  source: Schema.Literals(["live", "home", "local"]),
  /** The Home lets GOAT move this device's work to its own providers. Absent: no row for it. */
  localFallback: Schema.optional(Schema.Boolean),
});
export type OpenCodexDeviceFallback = typeof OpenCodexDeviceFallback.Type;

export const OpenCodexInventorySnapshot = Schema.Struct({
  installed: Schema.Boolean,
  binaries: Schema.Array(Schema.Struct({ path: Schema.String, version: Schema.String })),
  ownership: Schema.Literals(["adopted", "managed", "none"]),
  service: Schema.Struct({
    available: Schema.Boolean,
    installed: Schema.optional(Schema.Boolean),
    running: Schema.optional(Schema.Boolean),
    backend: Schema.optional(Schema.Literals(["launchd", "systemd", "scheduler", "native"])),
  }),
  runtime: Schema.Struct({
    ...OpenCodexProtocolEvidence.fields,
    version: Schema.optional(Schema.String),
    role: Schema.optional(Schema.Literals(["standalone", "hub", "client"])),
    port: Port,
    healthy: Schema.Boolean,
    ready: Schema.Boolean,
  }),
  link: Schema.Struct({
    role: Schema.Literals(["home", "child", "none"]),
    available: Schema.Boolean,
    links: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        alias: Schema.String,
        tunnelPort: Port,
        state: Schema.Literals([
          "connecting",
          "connected",
          "reconnecting",
          "failed",
          "idle",
          "unknown",
        ]),
        lastApplyAt: ForwardCompatibleOptional(Schema.Number),
        apiKeyId: Schema.optional(Schema.String),
      }),
    ),
    childSettingsApplied: Schema.NullOr(Schema.Boolean),
    /** The Home's name: its host name on the Home, the name it published on a Child. */
    homeName: ForwardCompatibleOptional(TrimmedNonEmptyString.check(Schema.isMaxLength(255))),
  }),
  hubClient: Schema.optional(
    Schema.Struct({
      state: Schema.Literals(["disconnected", "connected", "invalid", "mismatched"]),
      apiKeyId: Schema.optional(Schema.String),
      protocolVersion: Schema.optional(Protocol),
    }),
  ),
  parityEvidence: ForwardCompatibleOptional(HubParityEvidence),
  fallback: ForwardCompatibleOptional(OpenCodexDeviceFallback),
});
export type OpenCodexInventorySnapshot = typeof OpenCodexInventorySnapshot.Type;

/** `alias` null is the machine that coordinates the window: the Home, or a standalone install. */
const UpdateAlias = Schema.NullOr(Schema.String);

export const OpenCodexUpdateMemberRecord = Schema.Struct({
  alias: UpdateAlias,
  phase: Schema.Literals(["installed", "probation", "accepted", "rolled-back", "rollback-failed"]),
  fromVersion: Schema.String,
  targetVersion: Schema.String,
  at: Schema.Number,
  reason: Schema.optional(Schema.String),
});
export type OpenCodexUpdateMemberRecord = typeof OpenCodexUpdateMemberRecord.Type;

/** The coordinator's last managed-update decision; adopted installs only ever get advice. */
export const OpenCodexUpdateStatus = Schema.Struct({
  checkedAt: Schema.Number,
  decision: Schema.Literals(["none", "wait", "update"]),
  /** Machine-readable code such as `up-to-date`, `busy` or `child-cannot-follow`. */
  reason: Schema.String,
  targetVersion: Schema.optional(Schema.String),
  waitingOn: Schema.Array(UpdateAlias),
  advisories: Schema.Array(
    Schema.Struct({ alias: UpdateAlias, version: Schema.String, targetVersion: Schema.String }),
  ),
  members: Schema.Array(OpenCodexUpdateMemberRecord),
});
export type OpenCodexUpdateStatus = typeof OpenCodexUpdateStatus.Type;
