import { describe, expect, it } from "vite-plus/test";
import { BOT_PACKAGE_MAX_BYTES, decodeBotPackage } from "./botPackage.ts";

const sample = {
  version: 1,
  name: "Build Scout",
  face: null,
  color: null,
  purpose: "Review builds.",
  instructions: "Summarize failures.",
  automations: [],
  tools: { mcpServers: [], skills: [] },
};

describe("bot packages", () => {
  it("rejects invalid JSON, unsupported versions, and invalid automations", () => {
    expect(() => decodeBotPackage("{")).toThrow();
    expect(() => decodeBotPackage(JSON.stringify({ ...sample, version: 2 }))).toThrow();
    expect(() =>
      decodeBotPackage(
        JSON.stringify({ ...sample, automations: [{ schedule: { type: "shell" } }] }),
      ),
    ).toThrow();
  });

  it("checks the UTF-8 byte limit before decoding", () => {
    expect(() => decodeBotPackage(" ".repeat(BOT_PACKAGE_MAX_BYTES) + "{}")).toThrow(/size/i);
    expect(() =>
      decodeBotPackage(
        JSON.stringify({ ...sample, future: "é".repeat(BOT_PACKAGE_MAX_BYTES / 2) }),
      ),
    ).toThrow(/size/i);
  });

  it("lists unknown fields at their original locations and drops their values", () => {
    const automation = {
      title: "Check in",
      prompt: "Summarize progress",
      schedule: { type: "interval", everyMs: 60_000 },
    };
    const { botPackage, droppedFields } = decodeBotPackage(
      JSON.stringify({
        ...sample,
        slack: { value: "ignored" },
        tools: { ...sample.tools, configuration: "ignored" },
        automations: [
          { ...automation, enabled: true, schedule: { ...automation.schedule, secret: "ignored" } },
        ],
      }),
    );
    expect(botPackage).toEqual({ ...sample, automations: [automation] });
    expect(droppedFields).toEqual([
      "/automations/0/enabled",
      "/automations/0/schedule/secret",
      "/slack",
      "/tools/configuration",
    ]);
  });
});
