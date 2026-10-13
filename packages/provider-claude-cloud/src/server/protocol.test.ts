import { describe, expect, it } from "vite-plus/test";
import {
  ClaudeCloudError,
  parseAuth,
  readStartReceipt,
  readSendReceipt,
  sessionUrl,
  trustRequired,
} from "./protocol.ts";
import { RECEIPT } from "./testing.ts";

describe("Claude Cloud protocol", () => {
  it("normalizes the observed three-line PTY receipt and does not complete a split ID", () => {
    let raw = "";
    for (const character of RECEIPT.replace(/\r\n/g, "\n").slice(0, -1)) {
      raw += character;
      expect(readStartReceipt(raw)).toBeUndefined();
    }
    expect(readStartReceipt(RECEIPT)).toEqual({
      taskId: "session_ABC123",
      url: "https://claude.ai/code/session_ABC123",
      title: "Test task",
    });
    expect(readStartReceipt(`\u001b[32m${RECEIPT}\u001b[0m`)).toEqual(readStartReceipt(RECEIPT));
    expect(
      readStartReceipt(`\u001b]8;;https://example.invalid\u0007${RECEIPT}\u001b]8;;\u0007`),
    ).toEqual(readStartReceipt(RECEIPT));
  });
  it("requires labels and rejects conflicting IDs", () => {
    expect(readStartReceipt("https://claude.ai/code/session_ABC123\n")).toBeUndefined();
    expect(() =>
      readStartReceipt(RECEIPT.replace("--teleport session_ABC123", "--teleport session_OTHER")),
    ).toThrow();
    expect(() =>
      readStartReceipt(RECEIPT + "View: https://claude.ai/code/session_OTHER\n"),
    ).toThrow();
  });
  it.each([
    "http://claude.ai/code/session_ABC123",
    "https://claude.ai.evil.test/code/session_ABC123",
    "https://user@claude.ai/code/session_ABC123",
    "https://claude.ai:444/code/session_ABC123",
    "https://claude.ai/code/session_ABC123/extra",
    "https://claude.ai/code/session_ABC123#fragment",
  ])("rejects an unsafe receipt URL %s", (url) => expect(() => sessionUrl(url)).toThrow());
  it("reads auth JSON without borrowing local-provider eligibility", () => {
    expect(parseAuth('{"loggedIn":true,"authMethod":"claude.ai","email":"ignored"}')).toEqual({
      loggedIn: true,
      authMethod: "claude.ai",
    });
    expect(() => parseAuth("Logged in")).toThrow();
  });
  it("checks success identity and recognizes a JSON failure even with process exit zero", () => {
    expect(
      readSendReceipt(
        '{"ok":true,"session_id":"session_ABC123","url":"https://claude.ai/code/session_ABC123"}',
        "session_ABC123",
        {},
      ),
    ).toEqual({ taskId: "session_ABC123", url: "https://claude.ai/code/session_ABC123" });
    expect(() =>
      readSendReceipt('{"ok":false,"error":"archived fixture-secret"}', "session_ABC123", {
        TOKEN: "fixture-secret",
      }),
    ).toThrow("archived [redacted]");
    expect(() =>
      readSendReceipt(
        '{"ok":true,"session_id":"session_OTHER","url":"https://claude.ai/code/session_OTHER"}',
        "session_ABC123",
        {},
      ),
    ).toThrow(ClaudeCloudError);
  });
  it("recognizes a human-owned trust prompt", () => {
    expect(
      trustRequired("Do you trust the files in this folder?\r\n1. Yes, I trust this folder"),
    ).toBe(true);
    expect(trustRequired(RECEIPT)).toBe(false);
  });
});
