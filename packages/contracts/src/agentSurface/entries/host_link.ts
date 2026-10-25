import { entry } from "../entry.ts";

export const hostLinkEntries = {
  "host_link.create": entry({
    resource: "host_link",
    verb: "create",
    name: "goat_host_link_create",
    toolkit: "ssh",
    summary: "Link a GOAT host over HTTPS",
    description:
      "Link a GOAT host over HTTP(S) using its pairing code and save a local session. Reuse clientRequestId on retries. A name replaces its previous link; the old remote session stays valid. A code can be spent even if saving fails; read goat_host_link_list after an uncertain outcome.",
    guide:
      "This reaches a server directly rather than over SSH, including a headless goat serve exposed by Tailscale, LAN or GOAT Connect. Supply the pairing URL printed by goat pair or goat auth pairing create, or the origin and a separate code. The remote server issues an MCP client session; the local environment stores its token with the link. Use the saved name as host with tools such as goat_project_list, goat_ssh_thread_launch and host-aware goat_thread tools. The requested access defaults to approval-required and limits what the remote session can do; read-only cannot start threads, and a caller whose runtime mode ranks below the link's access cannot write through it. Sessions last 30 days; renew by linking again with a fresh code. Needs a live full-access/default calling thread or a full-access client and the orchestration capability; GOAT threads also need hub.manage when goatclaw is enabled. Names that already identify an SSH host are refused. The code exchange precedes the final authority recheck and local catalog write, so a storage failure or lost authority can leave a valid remote session without a saved local link. After an uncertain response, inspect goat_host_link_list before trying a new code. Links cannot answer approvals on remote threads; a person must answer from a client connected to the remote host.",
    effect: "write",
    capability: "hub.manage",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: ["pairing"],
    idempotency: "key",
    reconcile: "host_link.list",
    annotations: {
      title: "Link a GOAT host",
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
  "host_link.list": entry({
    resource: "host_link",
    verb: "list",
    name: "goat_host_link_list",
    toolkit: "ssh",
    summary: "List linked GOAT hosts",
    description:
      "List saved HTTP(S) links to other GOAT servers. Listing a link does not confirm that it is reachable or that its session is still valid.",
    guide:
      "These links belong to this environment and are created by goat_host_link_create. Public metadata includes each name, address, granted access and expiry, without the session token. Pass a saved name as host to host-aware tools. The list reads saved entries without probing the remote or filtering expired sessions. Needs the orchestration capability.",
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "List linked GOAT hosts",
      idempotentHint: true,
      openWorldHint: false,
    },
  }),
  "host_link.remove": entry({
    resource: "host_link",
    verb: "remove",
    name: "goat_host_link_remove",
    toolkit: "ssh",
    summary: "Remove a linked GOAT host",
    description:
      "Forget a linked host's address and session locally. Remote threads and projects remain; launch watches lose contact. The remote session stays valid until expiry unless revoked on that host.",
    guide:
      "Needs a live full-access/default calling thread or a full-access client, plus hub.manage for GOAT threads when goatclaw is enabled. To end access immediately, revoke the session on the remote host in Settings → Connections.",
    effect: "destructive",
    capability: "hub.manage",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    idempotencyReason:
      "LinkedHosts.unlink removes the catalog entry by name under its lock; a missing name is refused without another effect. The remote session and remote threads remain untouched.",
    annotations: {
      title: "Remove a linked GOAT host",
      idempotentHint: true,
      openWorldHint: false,
    },
  }),
} as const;
