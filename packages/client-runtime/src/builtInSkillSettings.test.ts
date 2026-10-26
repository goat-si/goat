import { DEFAULT_SERVER_SETTINGS, type ProjectId } from "@goat/contracts";
import { applyServerSettingsPatch } from "@goat/shared/serverSettings";
import { describe, expect, it } from "vite-plus/test";

import { builtInSkillEnvironmentPatch, builtInSkillProjectPatch } from "./builtInSkillSettings.ts";

const first = "first" as ProjectId;
const second = "second" as ProjectId;

describe("built-in skill settings patches", () => {
  it("opts one project out then inherits again without changing the other project", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [second]: { builtInSkills: { "goat-discipline": { enabled: false } } },
      },
    };
    const off = builtInSkillProjectPatch(settings, [first], "goat-discipline", false);
    expect(off).toEqual({ [first]: { builtInSkills: { "goat-discipline": { enabled: false } } } });
    const optedOut = applyServerSettingsPatch(settings, { projectSettingsOverrides: off });
    const inherit = builtInSkillProjectPatch(optedOut, [first], "goat-discipline", undefined);
    expect(inherit).toEqual({ [first]: { builtInSkills: {} } });
    const inherited = applyServerSettingsPatch(optedOut, { projectSettingsOverrides: inherit });
    expect(inherited.projectSettingsOverrides[first]).toBeUndefined();
    expect(inherited.projectSettingsOverrides[second]).toEqual(
      settings.projectSettingsOverrides[second],
    );
  });

  it("keeps sibling settings and other skill names on both explicit and inherited writes", () => {
    const settings = {
      projectSettingsOverrides: {
        [first]: {
          defaultAutoPull: true,
          builtInSkills: { other: { enabled: false }, "goat-discipline": { enabled: false } },
        },
      },
    };
    expect(builtInSkillProjectPatch(settings, [first], "goat-discipline", true)).toEqual({
      [first]: {
        defaultAutoPull: true,
        builtInSkills: { other: { enabled: false }, "goat-discipline": { enabled: true } },
      },
    });
    expect(builtInSkillProjectPatch(settings, [first], "goat-discipline", undefined)).toEqual({
      [first]: { defaultAutoPull: true, builtInSkills: { other: { enabled: false } } },
    });
    expect(
      builtInSkillProjectPatch(
        { projectSettingsOverrides: {} },
        [first],
        "goat-discipline",
        undefined,
      ),
    ).toEqual({ [first]: { builtInSkills: {} } });
    expect(settings.projectSettingsOverrides[first]?.builtInSkills["goat-discipline"].enabled).toBe(
      false,
    );
  });

  it("keeps newer names when enabling and disabling an environment skill", () => {
    const off = builtInSkillEnvironmentPatch(
      ["skill-from-a-newer-build"],
      "goat-discipline",
      false,
    );
    expect(off.disabledBuiltInSkills).toEqual(["skill-from-a-newer-build", "goat-discipline"]);
    expect(
      builtInSkillEnvironmentPatch(off.disabledBuiltInSkills, "goat-discipline", true),
    ).toEqual({ disabledBuiltInSkills: ["skill-from-a-newer-build"] });
  });
});
