import { describe, expect, it } from "vite-plus/test";
import { isSlashCommandMessage } from "./ContextHandoffDelivery.ts";

const user = (text: string) => ({ role: "user", text });

describe("isSlashCommandMessage", () => {
  it.each(["/compact", "/goal ship it", "  /goal"])(
    "treats GOAT's own command %s as one whose turn defers pending context",
    (text) => expect(isSlashCommandMessage(user(text), true)).toBe(true),
  );

  it("regression: keeps /goal an ordinary prompt on a session without native goals", () => {
    expect(isSlashCommandMessage(user("/goal ship it"), false)).toBe(false);
    expect(isSlashCommandMessage(user("/compact"), false)).toBe(true);
  });

  it.each([
    "/tmp inspect this directory",
    "/data inspect this directory",
    "/workspace explain this folder",
    "/README.md explain this file",
    "/Users/jun/app why does this fail",
    "/review the diff",
    "explain /compact",
  ])("regression: keeps %s an ordinary prompt that carries its context", (text) =>
    expect(isSlashCommandMessage(user(text), true)).toBe(false),
  );

  it("ignores assistant messages and commands with attachments", () => {
    expect(isSlashCommandMessage({ role: "assistant", text: "/compact" }, true)).toBe(false);
    expect(isSlashCommandMessage({ ...user("/goal ship it"), attachments: [{}] }, true)).toBe(
      false,
    );
  });
});
