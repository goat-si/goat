import { DEFAULT_CLIENT_SETTINGS, type OpenCodexInventorySnapshot } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type FirstRunPromptInput,
  foldLegacyFirstRunPrompt,
  openCodexSituation,
  planFirstRunPrompts,
} from "./firstRunPrompts.logic";

const pending = { computerUse: "pending", opencodex: "pending", goatclaw: "pending" } as const;

describe("foldLegacyFirstRunPrompt", () => {
  it("keeps an earlier computer-use answer and drops the old key", () => {
    const enabled = foldLegacyFirstRunPrompt({
      ...DEFAULT_CLIENT_SETTINGS,
      computerUsePrompt: "enabled",
    });
    expect(enabled.firstRunPrompts.computerUse).toBe("answered");
    expect("computerUsePrompt" in enabled).toBe(false);
    expect(
      foldLegacyFirstRunPrompt({ ...DEFAULT_CLIENT_SETTINGS, computerUsePrompt: "later" })
        .firstRunPrompts.computerUse,
    ).toBe("later");
    expect(
      foldLegacyFirstRunPrompt({ ...DEFAULT_CLIENT_SETTINGS, computerUsePrompt: "pending" })
        .firstRunPrompts,
    ).toEqual(pending);
  });

  it("never overwrites an answer already in the record", () => {
    const folded = foldLegacyFirstRunPrompt({
      ...DEFAULT_CLIENT_SETTINGS,
      firstRunPrompts: { ...pending, computerUse: "later" },
      computerUsePrompt: "enabled",
    });
    expect(folded.firstRunPrompts.computerUse).toBe("later");
  });
});

function inventory(
  link: Partial<OpenCodexInventorySnapshot["link"]>,
  extra: Partial<OpenCodexInventorySnapshot> = {},
): OpenCodexInventorySnapshot {
  return {
    installed: true,
    binaries: [],
    ownership: "adopted",
    service: { available: false },
    runtime: { port: 10100, healthy: true, ready: true },
    link: { role: "none", available: true, links: [], childSettingsApplied: null, ...link },
    ...extra,
  };
}

describe("openCodexSituation", () => {
  it("reads the Home, a linked device and a standalone install", () => {
    expect(openCodexSituation(undefined)).toBeNull();
    expect(openCodexSituation({ ...inventory({}), installed: false })).toBeNull();
    expect(
      openCodexSituation(
        inventory({
          role: "home",
          links: [{ id: "lnk_a", alias: "macmini-ts", tunnelPort: 54958, state: "connected" }],
        }),
      ),
    ).toEqual({ kind: "home", devices: 1 });
    expect(openCodexSituation(inventory({ role: "child", homeName: "jun-mbp" }))).toEqual({
      kind: "linked",
      homeName: "jun-mbp",
    });
    expect(openCodexSituation(inventory({}, { hubClient: { state: "connected" } }))).toEqual({
      kind: "linked",
      homeName: null,
    });
    expect(openCodexSituation(inventory({}))).toEqual({ kind: "unlinked" });
  });
});

describe("planFirstRunPrompts", () => {
  const base: FirstRunPromptInput = {
    prompts: pending,
    opencodex: { kind: "home", devices: 2 },
    codexInstanceId: "codex",
    codexUsesHome: false,
    goatclawOn: false,
    canConfigure: true,
  };

  it("asks OpenCodex, then goatclaw, then computer use", () => {
    expect(planFirstRunPrompts(base).show).toBe("opencodex");
    expect(planFirstRunPrompts({ ...base, prompts: { ...pending, opencodex: "later" } }).show).toBe(
      "goatclaw",
    );
    expect(
      planFirstRunPrompts({
        ...base,
        prompts: { ...pending, opencodex: "answered", goatclaw: "answered" },
      }).show,
    ).toBe("computerUse");
    expect(
      planFirstRunPrompts({
        ...base,
        prompts: { computerUse: "later", opencodex: "answered", goatclaw: "later" },
      }).show,
    ).toBeNull();
  });

  it("shows nothing until this machine's OpenCodex state is known", () => {
    expect(planFirstRunPrompts({ ...base, opencodex: "loading" }).show).toBeNull();
  });

  it("skips both hub questions where OpenCodex is not installed", () => {
    expect(planFirstRunPrompts({ ...base, opencodex: null })).toEqual({
      show: "computerUse",
      answeredElsewhere: [],
    });
  });

  it("asks a linked device about Codex but never about becoming the hub", () => {
    const linked = { ...base, opencodex: { kind: "linked", homeName: "jun-mbp" } } as const;
    expect(planFirstRunPrompts(linked).show).toBe("opencodex");
    expect(
      planFirstRunPrompts({ ...linked, prompts: { ...pending, opencodex: "answered" } }).show,
    ).toBe("computerUse");
  });

  it("skips the OpenCodex question without a Codex instance, and goatclaw without settings access", () => {
    expect(planFirstRunPrompts({ ...base, codexInstanceId: null }).show).toBe("goatclaw");
    expect(planFirstRunPrompts({ ...base, codexInstanceId: null, canConfigure: false }).show).toBe(
      "computerUse",
    );
  });

  it("records a question answered elsewhere instead of asking it", () => {
    expect(planFirstRunPrompts({ ...base, codexUsesHome: true, goatclawOn: true })).toEqual({
      show: "computerUse",
      answeredElsewhere: ["opencodex", "goatclaw"],
    });
  });
});
