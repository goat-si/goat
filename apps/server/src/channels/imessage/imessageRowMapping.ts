import type { ChannelInboundMessage } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import type { ImessageRow } from "./imessageChatDb.ts";
import type { ImessageSettings } from "./ImessageChannelSettings.ts";
import { normalizeHandle } from "./ImessageChannelSettings.ts";

const MAX_ARCHIVE_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 16 * 1024;
const marker = new TextEncoder().encode("NSString");

export function extractTypedstreamText(
  body: Uint8Array | null,
  maxBytes = MAX_ARCHIVE_BYTES,
): string | undefined {
  if (body === null || body.length > maxBytes) return undefined;
  for (let i = 0; i + marker.length + 2 < body.length; i += 1) {
    if (!marker.every((byte, offset) => body[i + offset] === byte)) continue;
    let start = i + marker.length;
    // NSString payload follows a typedstream '+' marker.
    while (start < body.length && body[start] !== 0x2b && start < i + marker.length + 16)
      start += 1;
    if (body[start] !== 0x2b) return undefined;
    start += 1;
    const head = body[start++];
    if (head === undefined) return undefined;
    let size: number;
    if (head < 0x80) size = head;
    else if (head === 0x81) {
      if (start + 2 > body.length) return undefined;
      size = body[start]! | (body[start + 1]! << 8);
      start += 2;
    } else if (head === 0x82) {
      if (start + 4 > body.length) return undefined;
      size =
        body[start]! |
        (body[start + 1]! << 8) |
        (body[start + 2]! << 16) |
        (body[start + 3]! << 24);
      start += 4;
    } else return undefined;
    if (size <= 0 || size > MAX_TEXT_BYTES || start + size > body.length) return undefined;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(start, start + size));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export type ImessageAdmission =
  | { readonly type: "skip"; readonly reason: string }
  | { readonly type: "pending_join"; readonly rowId: number }
  | {
      readonly type: "message";
      readonly rowId: number;
      readonly guid: string;
      readonly chatGuid: string;
      readonly senderHandle: string;
      readonly text: string;
      readonly receivedAt: string;
    };

export function admitImessageRow(row: ImessageRow, settings: ImessageSettings): ImessageAdmission {
  if (
    row.is_from_me !== 0 ||
    row.item_type !== 0 ||
    (row.associated_message_type !== null && row.associated_message_type !== 0) ||
    row.balloon_bundle_id !== null
  )
    return { type: "skip", reason: "unsupported_kind" };
  const senderHandle = row.sender_handle === null ? undefined : normalizeHandle(row.sender_handle);
  if (
    row.sender_service !== "iMessage" ||
    senderHandle === undefined ||
    !settings.allowedHandles.has(senderHandle) ||
    settings.ownHandles.has(senderHandle) ||
    !row.guid
  )
    return { type: "skip", reason: "sender" };
  const text = (row.text ?? extractTypedstreamText(row.attributedBody))
    ?.replaceAll("\ufffc", "")
    .trim();
  if (!text) return { type: "skip", reason: "text" };
  if (row.chat_join_count === 0) return { type: "pending_join", rowId: row.rowid };
  if (row.chat_join_count !== 1 || row.style !== 45 || !row.chat_guid)
    return { type: "skip", reason: "chat" };
  const appleMs = row.date > 100_000_000_000 ? row.date / 1_000_000 : row.date * 1_000;
  const epochMs = appleMs + 978_307_200_000;
  const receivedAt =
    Number.isFinite(epochMs) && epochMs >= 978_307_200_000 && epochMs <= 7_258_118_400_000
      ? DateTime.formatIso(DateTime.makeUnsafe(epochMs))
      : DateTime.formatIso(
          DateTime.makeUnsafe(978_307_200_000 + Math.max(0, Math.min(row.rowid, 10_000_000_000))),
        );
  return {
    type: "message",
    rowId: row.rowid,
    guid: row.guid,
    chatGuid: row.chat_guid,
    senderHandle,
    text,
    receivedAt,
  };
}

export function toImessageInbound(
  input: Extract<ImessageAdmission, { type: "message" }>,
  settings: ImessageSettings,
): ChannelInboundMessage {
  return {
    kind: "imessage",
    connectionId: settings.connectionId,
    conversationKey: input.chatGuid,
    externalMessageId: input.guid,
    idempotencyKey: settings.connectionId + ":" + input.rowId,
    actor: { externalActorId: input.senderHandle },
    replyAddress: {
      kind: "imessage",
      connectionId: settings.connectionId,
      chatGuid: input.chatGuid,
    },
    text: input.text,
    attachments: [],
    receivedAt: input.receivedAt,
    intent: "message",
  };
}

export function classifyImessageText(
  text: string,
):
  | { readonly type: "message"; readonly text: string }
  | { readonly type: "link"; readonly code: string }
  | { readonly type: "notice"; readonly notice: "link_help" | "link_invalid" } {
  if (!/^link(?:\s|$)/i.test(text)) return { type: "message", text };
  if (/^link\s*$/i.test(text)) return { type: "notice", notice: "link_help" };
  const match = /^link\s+(\d{6})$/i.exec(text);
  return match?.[1] === undefined
    ? { type: "notice", notice: "link_invalid" }
    : { type: "link", code: match[1] };
}
