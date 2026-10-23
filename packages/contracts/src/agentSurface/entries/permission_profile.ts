import { entry } from "../entry.ts";

export const permissionProfileEntries = {
  "permission_profile.read": entry({
    resource: "permission_profile",
    verb: "read",
    name: "goat_permission_profile_get",
    toolkit: "fleet",
    summary: "Read the caller's effective permission profile.",
    description:
      "Read whether goatclaw is enabled, the caller's effective permission profile, and its runtime mode ceiling after narrowing. Thread callers use their inherited profile; outside MCP clients use the server default. This grants no new authority.",
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { idempotentHint: true, openWorldHint: false },
  }),
  "permission_profile.sync": entry({
    resource: "permission_profile",
    verb: "sync",
    name: "goat_goatclaw_sync",
    toolkit: "fleet",
    summary: "Exchange goatclaw policy with a connected GOAT.",
    description:
      "Used by a connected GOAT, not by agents: goatclaw is on or off for the whole fleet, so a machine sends its policy and this one keeps whichever was changed last, returning the result. Needs an outside client with settings:write.",
    effect: "write",
    capability: "none",
    capabilityReason:
      "Carries the goatclaw policy itself between hosts; gating it on that policy would let a stale copy refuse its own update. A settings:write client session authorizes it.",
    hostRoutable: false,
    requires: "client",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { idempotentHint: true, openWorldHint: false },
  }),
} as const;
