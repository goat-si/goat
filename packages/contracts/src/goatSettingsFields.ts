import {
  GoatGlobalSkillSettingsFields,
  GoatGlobalSkillSettingsPatchFields,
} from "./globalSkills.ts";
import { GoatMcpServerSettingsFields, GoatMcpServerSettingsPatchFields } from "./mcpServers.ts";
import {
  OfferedSourceControlProviderSettingsFields,
  OfferedSourceControlProviderSettingsPatchFields,
} from "./offeredSourceControlProviders.ts";
import { PenServerSettingsFields, PenServerSettingsPatchFields } from "./penSettings.ts";

export const GoatSettingsFields = {
  ...GoatMcpServerSettingsFields,
  ...GoatGlobalSkillSettingsFields,
  ...OfferedSourceControlProviderSettingsFields,
  ...PenServerSettingsFields,
};
export const GoatSettingsPatchFields = {
  ...GoatMcpServerSettingsPatchFields,
  ...GoatGlobalSkillSettingsPatchFields,
  ...OfferedSourceControlProviderSettingsPatchFields,
  ...PenServerSettingsPatchFields,
};
