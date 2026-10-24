import { entry } from "../entry.ts";
import { SSH_HOST_ADD_CONVERGES } from "../idempotencyReasons.ts";

export const connectionEntries = {
  "connection.list": entry({
    resource: "connection",
    verb: "list",
    name: "goat_connection_list",
    toolkit: "connection",
    summary: "List saved connections",
    description:
      "List this GOAT server's saved nodes, routes and notices. The legacy connections array omits nodes whose environment identity is unknown.",
    guide:
      "The server owns this catalog; no attached desktop app is needed, including with goat serve alone. Nodes combine registered SSH hosts, linked hosts and owned cloud machines. The response excludes credentials.",
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
      "Preflight and save an SSH device in this server's node catalog and, when attached, the desktop catalog. Human approval only pins a new host key; call goat_ssh_host_add again with next.host to connect. If the desktop stops answering, check Settings → Connections before retrying.",
    guide:
      "This is the same operation as goat_ssh_host_add, accepting a configured SSH alias or a typed address. It probes before provisioning; a failed preflight returns its report. Saving needs a live full-access/default thread or a full-access client. The desktop may save successfully while hub registration fails; inspect desktopCatalog and hub.saved rather than assuming both catalogs were updated. Without the desktop, the server saves the node itself. If it cannot identify a host where GOAT has not run, it prepares the managed host, then retries registration; preparation still in progress returns saved:false with its actual result and reason. Repeated successful adds reuse an existing connection with created:false. SSH accepts public-key authentication and unauthenticated SSH such as Tailscale SSH; this path does not supply a password. Preflight needs the orchestration capability. Creating a host-trust handoff needs a running writable GOAT thread, and the person approving its fingerprint needs settings:write. Headless preparation needs environment:maintain. Authorization denied after preflight returns that report with outcome capability_denied and a reason identifying the missing authority. When preflight.destination.managed is true, goat_ssh_host_forget can remove GOAT's pin, including after a failed preflight.",
    effect: "write",
    capability: "hub.manage",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: ["host_trust", "approval", "sign_in"],
    idempotencyReason: SSH_HOST_ADD_CONVERGES,
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
      "Remove a saved node and its routes from this GOAT server, forgetting linked credentials locally. The remote server keeps running; its linked session remains valid until expiry or remote revocation.",
    guide:
      "Provide exactly one nodeId or legacy environmentId. The server performs removal without the desktop app. Cloud nodes must be managed in Settings → Connections → Cloud machines. When a node has a known environment identity, the tool also requests removal from the attached desktop catalog; desktopCatalog reports saved, not_attached or failed. A failed desktop update does not undo server removal. Needs a live full-access/default calling thread or a full-access client, plus hub.manage for a GOAT thread when goatclaw is enabled.",
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
