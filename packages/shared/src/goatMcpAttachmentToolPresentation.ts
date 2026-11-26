import { tool } from "./goatMcpToolDefinition.ts";

export const attachmentToolDefinitions = {
  goat_attachment_prepare_upload: tool(
    ["Prepare", "Preparing", "Prepared", "an attachment upload"],
    "attachment-prepare",
  ),
  goat_attachment_video_metadata: tool(
    ["Inspect", "Inspecting", "Inspected", "a video attachment"],
    "attachment-video-metadata",
  ),
  goat_attachment_pending_list: tool(
    ["List", "Listing", "Listed", "pending attachment uploads"],
    "attachment-list",
  ),
  goat_attachment_discard: tool(
    ["Discard", "Discarding", "Discarded", "a pending attachment"],
    "attachment-discard",
  ),
  goat_thread_send_attachments: tool(["Send", "Sending", "Sent", "attachments"], "attachment-send"),
};
