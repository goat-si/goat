import { describe, expect, it } from "vite-plus/test";

import {
  defaultAppearanceToApply,
  defaultThemeGeneration,
  defaultThemeToApply,
} from "./useDefaultTheme";

const BASE = {
  environmentId: "env-1",
  defaultTheme: "nightfall",
  defaultThemeSetAt: "2026-08-28T00:00:00.000Z",
  appliedGeneration: null,
  resolves: true,
} as const;

describe("default theme adoption", () => {
  it("applies each valid environment appearance generation once", () => {
    const input = {
      environmentId: "env-1",
      appearance: "dark",
      setAt: "2026-11-20",
      appliedGeneration: null,
    };
    const generation = defaultAppearanceToApply(input);
    expect(generation).not.toBeNull();
    expect(defaultAppearanceToApply({ ...input, appliedGeneration: generation })).toBeNull();
    expect(defaultAppearanceToApply({ ...input, appearance: "future" })).toBeNull();
    expect(
      defaultAppearanceToApply({ ...input, setAt: "2026-11-21", appliedGeneration: generation }),
    ).not.toBeNull();
  });
  it("does not replay a generation it already applied", () => {
    const generation = defaultThemeGeneration(BASE.defaultTheme, BASE.defaultThemeSetAt);
    expect(defaultThemeToApply({ ...BASE, appliedGeneration: generation })).toBe(null);
  });

  it("applies the same theme again when the environment re-sets it", () => {
    const applied = defaultThemeGeneration(BASE.defaultTheme, "2026-08-28T00:00:00.000Z");
    const next = defaultThemeToApply({
      ...BASE,
      defaultThemeSetAt: "2026-08-29T00:00:00.000Z",
      appliedGeneration: applied,
    });
    expect(next).not.toBe(null);
    expect(next).not.toBe(applied);
  });
});
