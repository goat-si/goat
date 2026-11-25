import { describe, expect, it } from "vite-plus/test";
import { isSlashCommandMessage } from "./ContextHandoffDelivery.ts";

const user = (text: string) => ({ role: "user", text });

describe("isSlashCommandMessage", () => {
  it.each(["/compact", "/goal ship it", "  /review the diff", "/plugin:run now", "/init"])(
    "treats %s as a command whose turn defers pending context",
    (text) => expect(isSlashCommandMessage(user(text))).toBe(true),
  );

  it.each([
    "/tmp inspect this directory",
    "/README.md explain this file",
    "/Users/jun/app why does this fail",
    "/usr/local/bin is on PATH",
    "explain /compact",
  ])("regression: keeps the path-led prompt %s an ordinary prompt with its context", (text) =>
    expect(isSlashCommandMessage(user(text))).toBe(false),
  );

  it("ignores assistant messages", () =>
    expect(isSlashCommandMessage({ role: "assistant", text: "/compact" })).toBe(false));
});
