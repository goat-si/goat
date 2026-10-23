import { entry } from "../entry.ts";

export const connectionEntries = {
  "connection.list": entry({
    resource: "connection",
    verb: "list",
    name: "goat_connection_list",
    toolkit: "connection",
    summary: "List saved connections",
    description:
      "List nodes owned by this GOAT server (the hub), including routes and notices. Works without the desktop app, including goat serve alone. Legacy connections includes only nodes with a known environmentId. No credentials are returned.",
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "List saved connections",
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
  "connection.add_ssh": entry({
    resource: "connection",
    verb: "add_ssh",
    name: "goat_connection_add_ssh",
    toolkit: "connection",
    summary: "Add an SSH device",
    description:
      "Alias of goat_ssh_host_add. Add an SSH device from a configured host alias or typed address. Runs preflight, asks a person to pin a new fingerprint, then saves the device when a full-access caller is available: in the desktop catalog when the GOAT desktop app is attached (desktopCatalog saved), and always in this GOAT server's (the hub's) node list (hub.saved, works without the desktop app). After approval call goat_ssh_host_add with next.host. A host GOAT has not run on yet is prepared first and then registered; otherwise returns saved:false with the result and reason. Key authentication only. Repeated calls return an existing connection with created:false. Preflight needs the orchestration capability. Creating a host trust handoff needs a running GOAT thread, and the approving person needs settings:write; saving needs full access; headless preparation needs environment:maintain. Denied steps return the preflight report with outcome capability_denied and the missing authority in reason. When preflight fails on a host GOAT pinned (preflight.destination.managed), goat_ssh_host_forget removes that pin.",
    effect: "write",
    capability: "hub.manage",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: ["host_trust", "approval", "sign_in"],
    annotations: {
      title: "Add an SSH device",
      idempotentHint: true,
      openWorldHint: true,
    },
  }),
  "connection.remove": entry({
    resource: "connection",
    verb: "remove",
    name: "goat_connection_remove",
    toolkit: "connection",
    summary: "Remove a saved connection",
    description:
      "Remove a node owned by this GOAT server (the hub), using exactly one of nodeId or the legacy environmentId. Works without the desktop app. Linked credentials are forgotten; cloud nodes must be managed in Settings → Connections → Cloud machines. The remote GOAT server keeps running. The desktop sidebar is updated when the desktop app is attached; desktopCatalog reports saved, not_attached or failed.",
    effect: "destructive",
    capability: "hub.manage",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: ["pairing"],
    annotations: {
      title: "Remove a saved connection",
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
} as const;
