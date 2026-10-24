import { describe, expect, it } from "vite-plus/test";

import { buildRuntimeInstructions } from "../runtimeInstructions.ts";
import { COMPUTER_USE_PLATFORM_NOTES } from "./computerUse.ts";
import { builtInSkillSections, resolveBuiltInSkills } from "./registry.ts";

/**
 * Identifiers that exist only in other vendors' computer use skills and tool surfaces (#1161,
 * #1230). GOAT's skill is written for GOAT's own tools; any of these in it means vendor text
 * leaked in. Identifiers only, never copied prose.
 */
const VENDOR_ONLY_IDENTIFIERS = [
  "sky",
  "get_app_state",
  "perform_secondary_action",
  "select_text",
  "cua_repl",
  "js_reset",
  "turn_ended",
  "unified-computer-use",
  "computer-history",
  "openai-bundled",
  "aside-daemon",
  "AtYourSide",
  "Aside Computer Use",
  "runtime-computer-use",
];

const PLATFORMS = ["darwin", "win32", "linux", "freebsd"] as const;

describe("built-in skill activation", () => {
  it("loads the computer use skill only on turns with computer use attached", () => {
    expect(resolveBuiltInSkills({ attached: ["computer"] }).active).toEqual(["computer-use"]);
    expect(resolveBuiltInSkills({ attached: [] }).active).toEqual([]);
    expect(resolveBuiltInSkills({ attached: ["browser"] }).active).toEqual([]);
  });

  it("keeps a skill switched off in Settings off unless this turn requests its capability", () => {
    expect(
      resolveBuiltInSkills({ attached: ["computer"], disabled: ["computer-use"] }).active,
    ).toEqual([]);
    expect(
      resolveBuiltInSkills({
        attached: ["computer"],
        requested: ["computer"],
        disabled: ["computer-use"],
      }).active,
    ).toEqual(["computer-use"]);
  });

  it("reports a requested capability that is not attached instead of dropping it", () => {
    expect(resolveBuiltInSkills({ attached: [], requested: ["computer", "browser"] })).toEqual({
      active: [],
      unattached: ["computer", "browser"],
    });
  });
});

describe("computer use skill text", () => {
  it("fits every section into one Codex context entry on every host", () => {
    for (const platform of PLATFORMS)
      for (const section of builtInSkillSections(["computer-use"], platform))
        expect(new TextEncoder().encode(section).byteLength).toBeLessThanOrEqual(4_000);
  });

  it("carries only the notes for the host it controls", () => {
    const mac = builtInSkillSections(["computer-use"], "darwin").join("\n");
    expect(mac).toContain('os="macOS"');
    expect(mac).not.toContain('os="Windows"');
    expect(builtInSkillSections(["computer-use"], "freebsd")).toHaveLength(1);
  });

  it("contains no identifier from another vendor's computer use skill", () => {
    const text = [
      ...builtInSkillSections(["computer-use"], "darwin"),
      ...Object.values(COMPUTER_USE_PLATFORM_NOTES),
    ].join("\n");
    for (const identifier of VENDOR_ONLY_IDENTIFIERS)
      // Identifiers hold only letters, digits, `_`, `-` and spaces, so they need no escaping.
      expect(text, identifier).not.toMatch(new RegExp(`(^|[^\\w-])${identifier}([^\\w-]|$)`, "i"));
  });

  it("is in the runtime instructions exactly when the turn has computer use", () => {
    expect(buildRuntimeInstructions({ harness: "Codex", computerUse: true })).toContain(
      "<computer_use>",
    );
    expect(buildRuntimeInstructions({ harness: "Codex", computerUse: false })).not.toContain(
      "<computer_use>",
    );
  });
});
