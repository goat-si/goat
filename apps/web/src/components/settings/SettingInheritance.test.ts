import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ProjectId } from "@goat/contracts";
import { LEGACY_PROJECT_FILE_NAME } from "@goat/contracts/legacyT3Names";
import { resolveProjectSettings } from "@goat/shared/projectSettings";
import { describe, expect, it } from "vite-plus/test";

import { settingInheritanceLayers } from "./SettingInheritance";

const environmentId = EnvironmentId.make("laptop");
const projectId = ProjectId.make("project");

describe("settingInheritanceLayers", () => {
  it.each(["goat.json", LEGACY_PROJECT_FILE_NAME])(
    "shows %s as the file-backed layer",
    (projectFileName) => {
      const file = { defaultThreadEnvMode: "worktree" as const };
      const fromFile = settingInheritanceLayers(
        {
          environmentId,
          label: "Laptop",
          projectId,
          projectFileName,
          ...resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId, null, file),
        },
        DEFAULT_SERVER_SETTINGS,
        "defaultThreadEnvMode",
      );
      expect(fromFile.map((layer) => [layer.label, layer.value, layer.effective])).toEqual([
        ["Project", "Inherits", false],
        ["Laptop", "Inherits", false],
        [projectFileName, "New worktree", true],
        ["Default", "Local", false],
      ]);
      const settings = { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "local" as const };
      const fromEnvironment = settingInheritanceLayers(
        {
          environmentId,
          label: "Laptop",
          projectId,
          ...resolveProjectSettings(settings, projectId, null, file),
        },
        settings,
        "defaultThreadEnvMode",
      );
      expect(fromEnvironment.map((layer) => [layer.value, layer.effective])).toEqual([
        ["Inherits", false],
        ["Local", true],
        ["Inherits", false],
        ["Local", false],
      ]);
    },
  );
});
