import { entry } from "../entry.ts";

export const attachmentEntries = {
  "attachment.prepare_upload": entry({
    resource: "attachment",
    verb: "prepare_upload",
    name: "goat_attachment_prepare_upload",
    toolkit: "attachment",
    summary: "Create the app's signed upload URL.",
    description:
      "Create a signed attachment upload URL and record its caller ownership. Uploading bytes and sending the attachment to a thread are separate steps; provider support depends on its adapter.",
    guide:
      "POST the exact file bytes to relativeUrl on this MCP server's HTTP origin. Then pass the attachment metadata and returned attachmentId to goat_thread_send_attachments. Preparing the URL does not send a thread message. The provider adapter decides attachment support.",
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
      "Delete a pending attachment upload and its ownership record. File removal is best effort, so success can leave the file on disk. Already-delivered thread attachments are never deleted.",
    guide:
      "Only the caller that prepared the upload can discard it. Discard removes the pending file and its caller ownership record; the delivered thread copy remains separate.",
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
