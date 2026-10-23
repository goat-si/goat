import { entry } from "../entry.ts";

export const attachmentEntries = {
  "attachment.prepare_upload": entry({
    resource: "attachment",
    verb: "prepare_upload",
    name: "goat_attachment_prepare_upload",
    toolkit: "attachment",
    summary: "Create the app's signed upload URL.",
    description:
      "Create the app's signed upload URL. POST the exact bytes to relativeUrl on this MCP server's HTTP origin, then pass the attachment metadata and returned ID to goat_thread_send_attachments. Upload is separate from sending; provider attachment support is decided by its adapter.",
    effect: "destructive",
    capability: "none",
    capabilityReason:
      "Stages the caller's own upload; delivering it to a thread needs thread.send_attachments.",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
  "attachment.discard": entry({
    resource: "attachment",
    verb: "discard",
    name: "goat_attachment_discard",
    toolkit: "attachment",
    summary: "Discard a pending upload.",
    description:
      "Discard a pending upload. Already-delivered thread attachments are never deleted by this operation.",
    effect: "destructive",
    capability: "none",
    capabilityReason: "Discards the caller's own pending upload.",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
} as const;
