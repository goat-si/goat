import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@goat/contracts";
import { deriveGoatBotModelSettings } from "@goat/client-runtime/goatBot";
import { describe, expect, it } from "vite-plus/test";

import { goatBotModelMenu, goatBotModelMenuPatch } from "./goatBotModelMenu";

const codex = ProviderInstanceId.make("codex");
const provider: ServerProvider = {
  instanceId: codex,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [
    { slug: "luna", name: "GPT-6-Luna", isCustom: false, isDefault: true, capabilities: null },
    { slug: "astra", name: "GPT-6-Astra", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
};

function state(goatBotModelSelection: ServerSettings["goatBotModelSelection"]) {
  return deriveGoatBotModelSettings({
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      defaultModelSelection: { instanceId: codex, model: "luna" },
      goatBotModelSelection,
    },
    providers: [provider],
  });
}

describe("goatBotModelMenu", () => {
  it("shows the automatic model and marks Automatic", () => {
    const menu = goatBotModelMenu(state(null));
    expect(menu.label).toBe("GPT-6-Luna");
    expect(menu.accessibilityLabel).toBe("GOAT Bot model: GPT-6-Luna (automatic)");
    expect(menu.items.filter((item) => item.selected).map((item) => item.title)).toEqual([
      "Automatic",
    ]);
  });

  it("marks a chosen model and offers Automatic to go back", () => {
    const chosen = state({ instanceId: codex, model: "astra" });
    const menu = goatBotModelMenu(chosen);
    expect(menu.label).toBe("GPT-6-Astra");
    expect(menu.items.filter((item) => item.selected).map((item) => item.title)).toEqual([
      "GPT-6-Astra",
    ]);
    expect(goatBotModelMenuPatch(chosen, "automatic")).toEqual({ goatBotModelSelection: null });
  });
});

describe("goatBotModelMenuPatch", () => {
  it("pins a model picked while automatic, even the one Automatic resolves to", () => {
    expect(goatBotModelMenuPatch(state(null), "codex:luna")).toEqual({
      goatBotModelSelection: { instanceId: codex, model: "luna" },
    });
  });

  it("changes nothing for the choice already in effect or an unknown one", () => {
    expect(goatBotModelMenuPatch(state(null), "automatic")).toBeNull();
    expect(
      goatBotModelMenuPatch(state({ instanceId: codex, model: "astra" }), "codex:astra"),
    ).toBeNull();
    expect(goatBotModelMenuPatch(state(null), "codex:gone")).toBeNull();
  });
});
