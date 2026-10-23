import { entry } from "../entry.ts";

export const hostLinkEntries = {
  "host_link.create": entry({
    resource: "host_link",
    verb: "create",
    name: "goat_host_link_create",
    toolkit: "ssh",
    summary: "Link a GOAT host over HTTPS",
    description:
      "Link another machine's GOAT server that this machine reaches over HTTPS (Tailscale, LAN or T3 Connect) instead of SSH, such as a headless goat serve. Pass url as the pairing URL that goat pair or goat auth pairing create printed on that host, or its address plus code. The one-time code is spent here; nothing else is stored on that host. Afterwards pass name as host to goat_project_list, goat_ssh_thread_launch and the goat_thread_* tools. access is the most the link may do there (default approval-required; read-only cannot start threads). A caller with a lower runtime mode cannot change anything through it. The link lasts 30 days; link again with a new code to renew. Linking an existing name replaces it. Needs a full-access caller.",
    effect: "write",
    capability: "hub.manage",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: ["pairing"],
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
      "List the GOAT hosts this environment linked over HTTPS with goat_host_link_create: each name, address, the access it was granted and when it expires. Pass a name as host to the host-aware tools. No credentials are returned.",
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
      "Forget a linked host's address and session on this machine. Its threads and projects stay on that host, and launch watches on it report it unreachable. The host keeps the session until it expires; revoke it there in Settings → Connections to end it now. Needs a full-access caller.",
    effect: "destructive",
    capability: "hub.manage",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "Remove a linked GOAT host",
      idempotentHint: true,
      openWorldHint: false,
    },
  }),
} as const;
