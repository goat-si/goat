import * as Schema from "effect/Schema";

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
      }),
    ),
    childSettingsApplied: Schema.NullOr(Schema.Boolean),
  }),
  hubClient: Schema.optional(
    Schema.Struct({
      state: Schema.Literals(["disconnected", "connected", "invalid", "mismatched"]),
      apiKeyId: Schema.optional(Schema.String),
      protocolVersion: Schema.optional(Protocol),
    }),
  ),
});
export type OpenCodexInventorySnapshot = typeof OpenCodexInventorySnapshot.Type;
