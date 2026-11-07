import {
  GoatGlobalSkillSettingsFields,
  GoatGlobalSkillSettingsPatchFields,
} from "./globalSkills.ts";
import { GoatMcpServerSettingsFields, GoatMcpServerSettingsPatchFields } from "./mcpServers.ts";

export const GoatSettingsFields = {
  ...GoatMcpServerSettingsFields,
  ...GoatGlobalSkillSettingsFields,
};
export const GoatSettingsPatchFields = {
  ...GoatMcpServerSettingsPatchFields,
  ...GoatGlobalSkillSettingsPatchFields,
};
