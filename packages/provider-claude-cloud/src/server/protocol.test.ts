import { describe, expect, it } from "vite-plus/test";
import {
  ClaudeCloudError,
  parseAuth,
  readStartReceipt,
  readSendReceipt,
  sessionUrl,
  trustRequired,
} from "./protocol.ts";
import { FOLDER_TRUST_PROMPT, RECEIPT, SYNTHETIC_FOLDER_TRUST_REFUSALS } from "./testing.ts";

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
    expect(trustRequired(`${FOLDER_TRUST_PROMPT}1. Yes, I trust this folder`)).toBe(true);
    expect(trustRequired(RECEIPT)).toBe(false);
  });
  // Refusal wording is synthetic; the native probe establishes the folder prompt only.
  it.each([FOLDER_TRUST_PROMPT, ...SYNTHETIC_FOLDER_TRUST_REFUSALS])(
    "recognizes specific ANSI folder trust output (%#)",
    (output) => {
      expect(trustRequired(`\u001b[33m${output}\u001b[0m`)).toBe(true);
      expect(trustRequired(RECEIPT.replace("Test task", output.trim()))).toBe(false);
    },
  );
  it.each([
    "Do you trust this algorithm?\n",
    "Error: trust validation failed\n",
    "Error: Workspace trust check failed\n",
    "Error: This folder is not trusted by the fixture's test users.\n",
    "Task: This directory is not trusted.\n",
    "Discuss whether this folder is trusted.\n",
  ])("does not infer folder rejection from generic trust output (%#)", (output) => {
    expect(trustRequired(output)).toBe(false);
  });
  it("waits for a terminated refusal line rather than rejecting a split generic diagnostic", () => {
    const prefix = "Error: This folder is not trusted";
    expect(trustRequired(prefix)).toBe(false);
    expect(trustRequired(`${prefix}.\n`)).toBe(true);
    let raw = "";
    for (const character of `${prefix} by the fixture's test users.\n`) {
      raw += character;
      expect(trustRequired(raw)).toBe(false);
    }
  });
});
