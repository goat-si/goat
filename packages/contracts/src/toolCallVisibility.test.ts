import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ClientSettingsPatch, ClientSettingsSchema, DEFAULT_CLIENT_SETTINGS } from "./settings.ts";

const decode = Schema.decodeUnknownSync(ClientSettingsSchema);
const encode = Schema.encodeSync(ClientSettingsSchema);
const decodePatch = Schema.decodeSync(ClientSettingsPatch);

describe("tool-call visibility client setting", () => {
  it("defaults to showing every tool call, also for settings stored before the setting", () => {
    expect(DEFAULT_CLIENT_SETTINGS.toolCallVisibility).toBe("showAll");
    const stored = { ...encode(DEFAULT_CLIENT_SETTINGS) } as Record<string, unknown>;
    delete stored.toolCallVisibility;
    expect(decode(stored).toolCallVisibility).toBe("showAll");
  });

  it("round-trips each choice, and a value a newer client stored keeps every other setting", () => {
    for (const visibility of ["showAll", "hideSuccessful", "hideAll", "zen"] as const) {
      const settings = { ...DEFAULT_CLIENT_SETTINGS, toolCallVisibility: visibility };
      expect(decode(encode(settings)).toolCallVisibility).toBe(visibility);
    }
    const stored = {
      ...encode({ ...DEFAULT_CLIENT_SETTINGS, chatWidth: "wide" }),
      toolCallVisibility: "summaries",
    };
    const settings = decode(stored);
    expect(settings.toolCallVisibility).toBe("showAll");
    expect(settings.chatWidth).toBe("wide");
  });

  it("patches the setting on its own", () => {
    expect(decodePatch({ toolCallVisibility: "zen" })).toEqual({
      toolCallVisibility: "zen",
    });
  });
});
