import { entry } from "../entry.ts";

export const hubEntries = {
  "hub.device_verify": entry({
    resource: "hub",
    verb: "device_verify",
    name: "goat_hub_device_verify",
    toolkit: "hostStatus",
    summary: "Verify that one device is served by this OpenCodex Home.",
    description:
      "Check a device's P1–P8 parity with this machine's OpenCodex Home. Verification reports evidence and failures; use goat_hub_device_repair to fix them.",
    guide:
      "The call reads the Home locally and requests goat_host_status with parity evidence on the device. Parity collection requests GET /v1/models on each machine. The verdict is ok, degraded, broken or unproven, with check IDs and reasons. Verification does not repair, sync, restart or join the device. Reaching the device needs a live caller allowed to use this machine's SSH keys; read-only MCP clients cannot make this call.",
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { idempotentHint: true, openWorldHint: true },
  }),
  "hub.device_join": entry({
    resource: "hub",
    verb: "device_join",
    name: "goat_hub_device_join",
    toolkit: "hostStatus",
    summary: "Join a device to this OpenCodex Home as a Remote Link Child or Hub client.",
    description:
      "Join a device to this OpenCodex Home and verify parity, repairing failing checks. Existing memberships are only verified; use goat_hub_device_repair to repair them. Approval does not resume the call: call again with the approved decisionId.",
    guide:
      "OpenCodex must already be installed on the device. Windows under Git Bash, MSYS or Cygwin defaults to a Hub client; an explicit remote-link request on Windows is refused before linking. Select hub-client for a device GOAT can reach only by password. Remote Link requires a direct SSH alias without ProxyJump or ProxyCommand. GOAT probes the offered fingerprint; an owner-profile caller skips approval only if it matches GOAT's pin. A missing or different pin needs a person's approval bound to the offered fingerprint, which is passed to ocx link add as --expect-fingerprint. An approved fingerprint can differ from the existing GOAT pin. A Hub client requires OpenCodex Hub mode here with public data and management origins. GOAT runs ocx hub invite locally, reads its single-use code transiently, and feeds it to ocx connect --pairing-code-stdin on the device through the SSH script. Link and data keys remain managed by OpenCodex; this service does not persist the pairing code. Needs hub.manage. For a new membership, a non-owner profile needs human approval; disabled goatclaw does not count as owner. In a thread, state needs_human also carries kind needs_human and a handoff whose ID is decisionId; outside a thread it creates a decision-inbox item. A person approves in a GOAT app. After a new join, the repair ladder runs only for failed checks, not merely unproven evidence, and can stop with unproven parity. Its restart guard omits subagent turns, as described by goat_hub_device_repair.",
    effect: "write",
    capability: "hub.manage",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: ["approval", "host_trust"],
    annotations: { idempotentHint: false, openWorldHint: true },
  }),
  "hub.device_leave": entry({
    resource: "hub",
    verb: "device_leave",
    name: "goat_hub_device_leave",
    toolkit: "hostStatus",
    summary: "Remove a Remote Link Child or Hub client from this OpenCodex Home.",
    description:
      "Disconnect a device from this OpenCodex Home, then revoke its link or data key. Failed device cleanup leaves Home authority intact until a person approves force-revocation. Approval does not resume the call: call again with the approved decisionId.",
    guide:
      "The device is cleaned up first over SSH with ocx disconnect and ocx restart, followed by a /healthz check for standalone mode. For a Remote Link Child, the Home then runs ocx link revoke --force and verifies that neither ocx link status nor its SSH reverse tunnels retain the link. For a Hub client it runs ocx access key remove for the device's data-key ID. If cleanup fails, the response is state needs_human with decisionId; approval permits revocation on the Home while leaving stale client settings on the device. Needs hub.manage. A non-owner profile first needs a person's approval to remove an existing member. In a thread, approvals also carry a handoff whose ID equals decisionId; otherwise they use the decision inbox. Forced removal reports degraded even after successful revocation because the device still needs ocx disconnect and ocx restart.",
    effect: "destructive",
    capability: "hub.manage",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: ["approval"],
    annotations: { idempotentHint: true, openWorldHint: true },
  }),
  "hub.device_repair": entry({
    resource: "hub",
    verb: "device_repair",
    name: "goat_hub_device_repair",
    toolkit: "hostStatus",
    summary: "Repair a device's parity with this OpenCodex Home.",
    description:
      "Verify device parity and repair failing checks with sync, restart and link reconnect. Restart checks omit subagent turns. Persistent failures may need an approved re-link that briefly removes routing; call again with the approved decisionId.",
    guide:
      "The ladder re-verifies after each executed step and stops when no check fails; unproven checks alone do not trigger repairs or prevent that stopping condition. Step 1 runs ocx sync on the device for P6 or P7 failures. Step 2 runs ocx restart there for P5; it defers if the reported top-level running count is nonzero or activity cannot be established. That count excludes subagents, so active subagent turns alone do not block a restart. Step 3 runs ocx link reconnect on this Home for P2 or P3 failures, only when a Remote Link record exists. Needs hub.manage. After steps 1–3, re-link consent is requested only if failures remain, the device has a Remote Link record, no restart was deferred, and the offered fingerprint can be probed. A thread receives a handoff whose ID equals decisionId; other callers get a decision-inbox item. Re-linking first disconnects and restarts the device, verifies standalone health, revokes the old Home link and checks that its record and tunnels are gone, then joins again. Approval is bound to the offered fingerprint; it does not execute the re-link until the tool is called again.",
    effect: "write",
    capability: "hub.manage",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: ["approval"],
    annotations: { idempotentHint: false, openWorldHint: true },
  }),
} as const;
