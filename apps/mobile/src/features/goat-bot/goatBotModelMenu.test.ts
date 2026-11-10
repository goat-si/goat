import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@goat/contracts";
import { deriveGoatBotModelSettings } from "@goat/client-runtime/goatBot";
import { describe, expect, it } from "vite-plus/test";

import {
  goatBotMemberModelChoice,
  goatBotMemberModelMenu,
  goatBotModelMenu,
  goatBotModelMenuPatch,
} from "./goatBotModelMenu";

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

  it("names a renamed bot in the menu's accessible name", () => {
    expect(goatBotModelMenu(state(null), "Goaty").accessibilityLabel).toBe(
      "Goaty model: GPT-6-Luna (automatic)",
    );
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

describe("a member bot's header model", () => {
  const main = state({ instanceId: codex, model: "astra" });

  it("shows the main bot's model while the member has none of its own", () => {
    const menu = goatBotMemberModelMenu(
      main,
      { name: "Research", defaultModelSelection: null },
      "Goaty",
    );
    expect(menu.label).toBe("GPT-6-Astra");
    expect(menu.accessibilityLabel).toBe("Research model: GPT-6-Astra (same as Goaty)");
    expect(menu.items.filter((item) => item.selected).map((item) => item.title)).toEqual([
      "Same as Goaty",
    ]);
  });

  it("shows the member's own model, and its slug when that model is not ready", () => {
    const own = goatBotMemberModelMenu(
      main,
      { name: "Research", defaultModelSelection: { instanceId: codex, model: "luna" } },
      "Goaty",
    );
    expect(own.label).toBe("GPT-6-Luna");
    expect(own.accessibilityLabel).toBe("Research model: GPT-6-Luna");
    expect(own.items.filter((item) => item.selected).map((item) => item.title)).toEqual([
      "GPT-6-Luna",
    ]);
    const gone = goatBotMemberModelMenu(
      main,
      { name: "Research", defaultModelSelection: { instanceId: codex, model: "retired" } },
      "Goaty",
    );
    expect(gone.label).toBe("retired");
    expect(gone.items.some((item) => item.selected)).toBe(false);
  });

  it("sends a picked model, null to go back to the main bot's, and nothing for the current one", () => {
    const luna = { instanceId: codex, model: "luna" };
    expect(goatBotMemberModelChoice(main, null, "codex:luna")).toEqual(luna);
    expect(goatBotMemberModelChoice(main, luna, "same")).toBeNull();
    expect(goatBotMemberModelChoice(main, null, "same")).toBeUndefined();
    expect(goatBotMemberModelChoice(main, luna, "codex:luna")).toBeUndefined();
    expect(goatBotMemberModelChoice(main, null, "codex:gone")).toBeUndefined();
  });
});
