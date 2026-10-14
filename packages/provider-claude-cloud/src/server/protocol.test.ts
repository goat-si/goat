import { describe, expect, it } from "vite-plus/test";
import {
  ClaudeCloudError,
  cleanOutput,
  parseAuth,
  readStartReceipt,
  readSendReceipt,
  redact,
  sessionUrl,
  trustRequired,
} from "./protocol.ts";
import { FOLDER_TRUST_PROMPT, RECEIPT, SYNTHETIC_FOLDER_TRUST_REFUSALS } from "./testing.ts";

// Minimal option line from the plain native node-pty capture; no cwd/account data or trust input.
const NATIVE_FOLDER_TRUST_OPTION =
  "\u001b[4GYes,\u001b[9GI\u001b[11Gtrust\u001b[17Gthis\u001b[22Gfolder\r\r\n";

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
  it("preserves native absolute-column word boundaries across split ANSI and words", () => {
    const completeAt = NATIVE_FOLDER_TRUST_OPTION.indexOf("folder") + "folder".length;
    let raw = "";
    for (const character of NATIVE_FOLDER_TRUST_OPTION) {
      raw += character;
      expect(trustRequired(raw)).toBe(raw.length >= completeAt);
    }
  });
  it("keeps cursor spacing local to trust detection, not receipts or redaction", () => {
    expect(cleanOutput(NATIVE_FOLDER_TRUST_OPTION)).toBe("Yes,Itrustthisfolder\n\n");
    expect(redact(NATIVE_FOLDER_TRUST_OPTION, {})).toBe("Yes,Itrustthisfolder");
    const receipt = readStartReceipt(
      RECEIPT.replace("Test task", NATIVE_FOLDER_TRUST_OPTION.trimEnd()),
    );
    expect(receipt).toEqual({
      taskId: "session_ABC123",
      url: "https://claude.ai/code/session_ABC123",
      title: "Yes,Itrustthisfolder",
    });
  });
  it.each(["Created cloud session:", "View:", "Resume with:"])(
    "excludes native cursor-spaced trust wording in a %s line",
    (label) => {
      expect(trustRequired(`${label} ${NATIVE_FOLDER_TRUST_OPTION}`)).toBe(false);
    },
  );
  it.each([
    NATIVE_FOLDER_TRUST_OPTION.replace("folder", "algorithm"),
    `Task: ${NATIVE_FOLDER_TRUST_OPTION}`,
    `${NATIVE_FOLDER_TRUST_OPTION.trimEnd()} by the fixture's test users.\n`,
    "Yes,Itrustthisfolder\n",
    NATIVE_FOLDER_TRUST_OPTION.replace(/G/g, "C"),
    NATIVE_FOLDER_TRUST_OPTION.replace(/\d+G/g, "G"),
  ])("does not broaden native trust detection beyond the anchored option (%#)", (output) => {
    expect(trustRequired(output)).toBe(false);
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
  it("keeps cursor-spaced synthetic refusals bounded and dependent on line termination", () => {
    const prefix = "Error: This folder is not trusted".replace(/ /g, "\u001b[9G");
    expect(trustRequired(prefix)).toBe(false);
    expect(trustRequired(`${prefix}.\n`)).toBe(true);
    let raw = prefix;
    for (const character of " by the fixture's test users.\n") {
      raw += character;
      expect(trustRequired(raw)).toBe(false);
    }
  });
});
