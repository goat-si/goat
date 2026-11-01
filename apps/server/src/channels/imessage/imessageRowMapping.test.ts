import { describe, expect, it } from "@effect/vitest";
import type { ImessageRow } from "./imessageChatDb.ts";
import type { ImessageSettings } from "./ImessageChannelSettings.ts";
import {
  admitImessageRow,
  classifyImessageText,
  extractTypedstreamText,
  toImessageInbound,
} from "./imessageRowMapping.ts";

const settings: ImessageSettings = {
  connectionId: "imessage-000000000001",
  allowedHandles: new Set(["+15550000000"]),
  ownHandles: new Set(["+15550000001"]),
  owner: {
    ownerId: "owner",
    principalId: "cli",
    displayName: "Owner",
    grantedScopes: ["orchestration:operate"],
    runtimeModeCeiling: "approval-required",
  },
};
const row: ImessageRow = {
  rowid: 12,
  guid: "g12",
  text: "Hi",
  attributedBody: null,
  handle_id: 1,
  is_from_me: 0,
  date: 0,
  date_read: null,
  cache_roomnames: null,
  associated_message_type: null,
  item_type: 0,
  balloon_bundle_id: null,
  sender_handle: "+15550000000",
  sender_service: "iMessage",
  chat_rowid: 1,
  chat_guid: "iMessage;-;+15550000000",
  chat_identifier: "+15550000000",
  style: 45,
  chat_join_count: 1,
};

describe("iMessage row mapping", () => {
  it("admits one allowlisted direct text and preserves the chat destination", () => {
    const admitted = admitImessageRow(row, settings);
    expect(admitted.type).toBe("message");
    if (admitted.type !== "message") return;
    expect(toImessageInbound(admitted, settings)).toMatchObject({
      kind: "imessage",
      idempotencyKey: "imessage-000000000001:12",
      replyAddress: { kind: "imessage", chatGuid: "iMessage;-;+15550000000" },
      actor: { externalActorId: "+15550000000" },
    });
  });
  it("fails closed for group, multiple joins, SMS, reactions and own messages", () => {
    for (const changed of [
      { style: 43 },
      { style: 99 },
      { chat_join_count: 2 },
      { sender_service: "SMS" },
      { associated_message_type: 2000 },
      { item_type: 1 },
      { is_from_me: 1 },
      { sender_handle: "+15550000001" },
      { text: "\ufffc" },
    ])
      expect(admitImessageRow({ ...row, ...changed }, settings).type).toBe("skip");
    expect(admitImessageRow({ ...row, chat_join_count: 0, chat_guid: null }, settings).type).toBe(
      "pending_join",
    );
  });
  it("accepts a normalized email sender and ignores chat_identifier for routing", () => {
    const emailSettings = { ...settings, allowedHandles: new Set(["person@example.com"]) };
    const admitted = admitImessageRow(
      { ...row, sender_handle: "PERSON@EXAMPLE.COM", chat_identifier: "other@example.com" },
      emailSettings,
    );
    expect(admitted.type).toBe("message");
    if (admitted.type === "message") {
      expect(admitted.senderHandle).toBe("person@example.com");
      expect(admitted.chatGuid).toBe(row.chat_guid);
    }
  });
  it("uses stable row metadata when the Apple timestamp is unusable", () => {
    expect(admitImessageRow({ ...row, date: Number.NaN }, settings)).toMatchObject({
      receivedAt: "2001-01-01T00:00:00.012Z",
    });
  });
  it("extracts only bounded NSString payload and strips attachment placeholders", () => {
    const text = new TextEncoder().encode("hello");
    const body = new Uint8Array([
      ...new TextEncoder().encode("NSString"),
      0x2b,
      text.length,
      ...text,
    ]);
    expect(extractTypedstreamText(body)).toBe("hello");
    const prefix = [...new TextEncoder().encode("NSString"), 0x2b];
    expect(extractTypedstreamText(new Uint8Array([...prefix, 0x81, 5, 0, ...text]))).toBe("hello");
    expect(extractTypedstreamText(new Uint8Array([...prefix, 0x82, 5, 0, 0, 0, ...text]))).toBe(
      "hello",
    );
    expect(extractTypedstreamText(new Uint8Array([...prefix, 0x81, 5]))).toBeUndefined();
    expect(
      extractTypedstreamText(new Uint8Array([...prefix, 0x05, 0xff, 0xff, 0xff, 0xff, 0xff])),
    ).toBeUndefined();
    expect(extractTypedstreamText(body, 4)).toBeUndefined();
    expect(admitImessageRow({ ...row, text: "\ufffc hi \ufffc" }, settings)).toMatchObject({
      text: "hi",
    });
  });
  it("classifies link/help/invalid without storing codes as ordinary messages", () => {
    expect(classifyImessageText("link 123456")).toEqual({ type: "link", code: "123456" });
    expect(classifyImessageText("link")).toEqual({ type: "notice", notice: "link_help" });
    expect(classifyImessageText("link nope")).toEqual({ type: "notice", notice: "link_invalid" });
  });
});
