import {
  DEFAULT_SERVER_SETTINGS,
  PROJECT_SETTINGS_OVERRIDES_REMOVAL,
  ProjectId,
  ProviderInstanceId,
  resolveProjectBuiltInSkillEnabled,
} from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyServerSettingsPatch } from "./serverSettings.ts";

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const optedOut = {
  ...DEFAULT_SERVER_SETTINGS,
  projectSettingsOverrides: {
    [projectA]: {
      newWorktreesStartFromOrigin: false,
      builtInSkills: { "goat-discipline": { enabled: false }, "skill-from-a-newer-build": {} },
    },
  },
};

describe("project built-in skill overrides", () => {
  it("switches a skill off for one project and leaves others on the environment value", () => {
    expect(resolveProjectBuiltInSkillEnabled(optedOut, projectA, "goat-discipline")).toBe(false);
    expect(resolveProjectBuiltInSkillEnabled(optedOut, projectB, "goat-discipline")).toBe(true);
    expect(resolveProjectBuiltInSkillEnabled(optedOut, null, "goat-discipline")).toBe(true);
    const environmentOff = { ...optedOut, disabledBuiltInSkills: ["goat-discipline"] };
    expect(resolveProjectBuiltInSkillEnabled(environmentOff, projectB, "goat-discipline")).toBe(
      false,
    );
    const projectOn = applyServerSettingsPatch(environmentOff, {
      projectSettingsOverrides: {
        [projectB]: { builtInSkills: { "goat-discipline": { enabled: true } } },
      },
    });
    expect(resolveProjectBuiltInSkillEnabled(projectOn, projectB, "goat-discipline")).toBe(true);
  });

  it("re-enables by returning the project to the environment value", () => {
    const reset = applyServerSettingsPatch(optedOut, {
      projectSettingsOverrides: {
        [projectA]: {
          newWorktreesStartFromOrigin: false,
          builtInSkills: { "skill-from-a-newer-build": {} },
        },
      },
    });
    expect(resolveProjectBuiltInSkillEnabled(reset, projectA, "goat-discipline")).toBe(true);
    expect(reset.projectSettingsOverrides[projectA]?.builtInSkills).toEqual({
      "skill-from-a-newer-build": {},
    });
  });

  it("keeps the opt-out when an older client rewrites the project's entry without the field", () => {
    const edited = applyServerSettingsPatch(optedOut, {
      projectSettingsOverrides: { [projectA]: { newWorktreesStartFromOrigin: true } },
    });
    expect(edited.projectSettingsOverrides[projectA]).toEqual({
      newWorktreesStartFromOrigin: true,
      builtInSkills: optedOut.projectSettingsOverrides[projectA]?.builtInSkills,
    });
  });

  it("keeps the opt-out when an older client clears its last visible project override", () => {
    const cleared = applyServerSettingsPatch(optedOut, {
      projectSettingsOverrides: { [projectA]: null },
    });
    expect(cleared.projectSettingsOverrides[projectA]).toEqual({
      builtInSkills: optedOut.projectSettingsOverrides[projectA]?.builtInSkills,
    });
    expect(resolveProjectBuiltInSkillEnabled(cleared, projectA, "goat-discipline")).toBe(false);
  });

  it("removes a deleted project's whole entry, skill and provider overrides included", () => {
    const instanceId = ProviderInstanceId.make("codex_work");
    const current = applyServerSettingsPatch(optedOut, {
      projectSettingsOverrides: {
        [projectA]: {
          builtInSkills: { "goat-discipline": { enabled: false } },
          providerInstances: { [instanceId]: { enabled: false } },
        },
      },
    });
    const removed = applyServerSettingsPatch(current, {
      projectSettingsOverrides: { [projectA]: PROJECT_SETTINGS_OVERRIDES_REMOVAL },
    });
    expect(removed.projectSettingsOverrides).toEqual({});
  });
});
