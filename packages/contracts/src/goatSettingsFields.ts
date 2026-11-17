import {
  GoatGlobalSkillSettingsFields,
  GoatGlobalSkillSettingsPatchFields,
} from "./globalSkills.ts";
import { GoatMcpServerSettingsFields, GoatMcpServerSettingsPatchFields } from "./mcpServers.ts";
import {
  OfferedSourceControlProviderSettingsFields,
  OfferedSourceControlProviderSettingsPatchFields,
} from "./offeredSourceControlProviders.ts";

export const GoatSettingsFields = {
  ...GoatMcpServerSettingsFields,
  ...GoatGlobalSkillSettingsFields,
  ...OfferedSourceControlProviderSettingsFields,
};
export const GoatSettingsPatchFields = {
  ...GoatMcpServerSettingsPatchFields,
  ...GoatGlobalSkillSettingsPatchFields,
  ...OfferedSourceControlProviderSettingsPatchFields,
};
