import type { ComponentProps } from "react";

import { GroupedCard } from "../ui/grouped-card";

/** The settings slot of the shared grouped card; settings CSS and rows target this slot. */
export function SettingsGroup(props: ComponentProps<typeof GroupedCard>) {
  return <GroupedCard data-slot="settings-group" {...props} />;
}
