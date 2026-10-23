import { entry } from "../entry.ts";

export const permissionProfileEntries = {
  "permission_profile.read": entry({
    resource: "permission_profile",
    verb: "read",
    name: "goat_permission_profile_get",
    toolkit: "fleet",
    summary: "Read the caller's effective permission profile.",
    description:
      "Read whether goatclaw is enabled, the caller's effective permission profile, and its narrowed runtime mode ceiling. This grants no new authority.",
    guide:
      "Thread callers use their inherited profile, narrowed by their launch ceiling and current runtime mode; an unbound thread uses the default profile. Outside MCP clients use the server default. When goatclaw is off, the result returns the default profile and the caller's runtime mode without enforcing profile narrowing.",
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
      "Used by a connected GOAT, not by agents: exchanges goatclaw fleet policy, keeps the most recently changed policy here, and returns it.",
    guide:
      "Use this for a connected GOAT's policy exchange. Agents cannot call it. Goatclaw is on or off across the fleet: a machine sends its policy, and this machine keeps the most recently changed policy and returns it. An outside client needs settings:write and a live authorization check. An incoming policy with no change timestamp does not replace the current policy; a different policy with an equal timestamp can replace it.",
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
