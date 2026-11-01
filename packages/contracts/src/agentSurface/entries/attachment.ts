import { entry } from "../entry.ts";

export const attachmentEntries = {
  "attachment.prepare_upload": entry({
    resource: "attachment",
    verb: "prepare_upload",
    name: "goat_attachment_prepare_upload",
    toolkit: "attachment",
    summary: "Create the app's signed upload URL.",
    description:
      "Create a signed attachment upload URL and record its caller ownership. Uploading bytes and sending the attachment to a thread are separate steps; provider support depends on its adapter. Retry with the same clientRequestId to get the first upload back.",
    guide:
      "POST the exact file bytes to relativeUrl on this MCP server's HTTP origin. Then pass the attachment metadata and returned attachmentId to goat_thread_send_attachments. Preparing the URL does not send a thread message. The provider adapter decides attachment support.\n\nA retry with the same clientRequestId returns the same attachmentId and URL; once expiresAt passes, prepare again with a new key. If the result was lost, goat_attachment_pending_list shows the uploads this caller prepared; discard one you cannot use, then prepare again with a new key.",
    idempotency: "key",
    reconcile: "attachment.pending_list",
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
      "Delete a pending attachment upload and its ownership record. If the file cannot be removed, the call fails and the caller keeps ownership, so it can discard again. Already-delivered thread attachments are never deleted.",
    guide:
      "Only the caller that prepared the upload can discard it. Discard removes the pending file and its caller ownership record; the delivered thread copy remains separate.",
    idempotencyReason:
      "Discard removes only the prepared caller-owned pending upload. Ownership is retained when removal fails so the caller can discard again, and removed only on success; a repeat after success fails ownership checks.",
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
  "attachment.pending_list": entry({
    resource: "attachment",
    verb: "pending_list",
    name: "goat_attachment_pending_list",
    toolkit: "attachment",
    summary: "List this caller's prepared uploads.",
    description:
      "List the uploads this caller prepared that are not yet sent or discarded, and whether their bytes arrived. Returns no upload URLs.",
    guide:
      "Each entry has the attachmentId, metadata, expiresAt of its upload URL and uploaded. Send an uploaded entry with goat_thread_send_attachments or remove it with goat_attachment_discard. Entries leave the list once sent or discarded, or after a day.",
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      idempotentHint: true,
      openWorldHint: false,
    },
  }),
} as const;
