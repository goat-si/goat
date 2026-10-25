import { entry } from "../entry.ts";

export const storageEntries = {
  "storage.usage": entry({
    resource: "storage",
    verb: "usage",
    name: "goat_storage_usage",
    toolkit: "storage",
    summary: "Show what GOAT's folders hold on a machine",
    description:
      "Read free disk space and what GOAT's own folders hold on this machine or host: worktrees and their node_modules and target/, leftover folders, stale git registrations, old runtimes, rotated logs, temp folders, kache. Each item says whether cleanup may remove it and why. Supports host.",
    guide:
      "Items carry an id and a token. Pass both to goat_storage_clean; a token stops matching once the item changes. state is removable, needs_attention (holds work or could not be checked; never deleted), protected (in use) or report_only. selected marks the default selection. A scan is cached for a few minutes; rescan:true scans now, which can take a minute on machines with many worktrees.\n\nPass host from goat_ssh_host_list or goat_host_link_list to read that machine's GOAT environment. Host calls require a live caller permitted to reach other machines with this machine's credentials.",
    effect: "read",
    hostRoutable: true,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "Show what GOAT's folders hold",
      idempotentHint: true,
      openWorldHint: false,
    },
  }),
  "storage.clean": entry({
    resource: "storage",
    verb: "clean",
    name: "goat_storage_clean",
    toolkit: "storage",
    summary: "Delete removable GOAT storage after a person approves",
    description:
      "Preview or delete removable items from goat_storage_usage on this machine. dryRun defaults to true. dryRun:false asks a person to approve exactly those items; call again with the same items and approvalId once they have.",
    guide:
      "Without items, a dry run previews the default selection: removable items in the categories that are safe to clear. dryRun:false needs items, each {id, token} as listed, and a full-access/default caller. From a thread the first call returns needs_human with an approval handoff bound to exactly those items on this machine; another client gets a decision GOAT filed for them. After a person approves, call again with the same items and approvalId (the handoffId or decision id). An approval is used once. People delete from Settings > Storage without this tool.\n\nEvery item is checked again right before deletion: worktrees must have no uncommitted changes and no commits missing from remotes, and no thread on any GOAT server on the machine may use them; a changed token, a link, or a path outside GOAT's folders is skipped. Each deletion is logged on that machine. Writes another GOAT server makes to a checkout after the final check and before removal completes are not protected; GOAT has no lock shared between servers.",
    capability: "none",
    capabilityReason:
      "A caller only asks a person to approve the exact items; deletion runs once that approval is given, and each approval is used once.",
    idempotencyReason:
      "StorageReclaim.clean rescans and deletes only items whose identity token still matches, and an approval handoff is consumed once. A repeated call finds removed items gone and skips them.",
    effect: "destructive",
    hostRoutable: false,
    requires: "either",
    dryRun: "supported",
    humanSteps: ["approval"],
    annotations: {
      title: "Delete removable GOAT storage",
      idempotentHint: false,
      openWorldHint: false,
    },
  }),
} as const;
