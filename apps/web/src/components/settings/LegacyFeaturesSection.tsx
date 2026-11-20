import { useGT } from "gt-react";
import { useState } from "react";
import { ChevronRightIcon } from "~/components/solar";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Switch } from "../ui/switch";
import { SettingsGroup } from "./SettingsGroup";
import { LEGACY_FEATURE_TARGET_IDS } from "./SettingsPanels.logic";
import { SettingsRow, useSettingsSearchTarget, useSettingsSearchTargetId } from "./settingsLayout";
import { useTranslatedSearchableSetting } from "./useTranslatedSearchableSetting";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function LegacyFeaturesSection() {
  const setting = useTranslatedSearchableSetting();
  const gt = useGT();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const [open, setOpen] = useState(false);
  const searchTargetId = useSettingsSearchTargetId();
  const targetRef = useSettingsSearchTarget<HTMLElement>("legacy-features");
  // A search jump to a legacy setting opens the fold before its row mounts.
  const [seenSearchTargetId, setSeenSearchTargetId] = useState<string | null>(null);
  if (seenSearchTargetId !== searchTargetId) {
    setSeenSearchTargetId(searchTargetId);
    if (searchTargetId !== null && LEGACY_FEATURE_TARGET_IDS.has(searchTargetId)) setOpen(true);
  }

  return (
    <section id="legacy-features" ref={targetRef} tabIndex={-1} className="space-y-2.5">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="group flex min-h-8 w-full items-center gap-2 px-3 sm:px-4">
          <h2 className="text-sm font-normal text-foreground/70 transition-colors group-hover:text-foreground">
            {gt("Legacy features")}
          </h2>
          <ChevronRightIcon className="size-4 text-muted-foreground transition-transform duration-200 group-data-panel-open:rotate-90" />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <SettingsGroup>
            <SettingsRow
              {...setting("legacy-plan-mode")}
              description={gt(
                "Restore Build/Plan, /plan, /default, and Shift+Tab. Off uses build mode.",
              )}
              control={
                <Switch
                  checked={settings.planModeEnabled}
                  onCheckedChange={(checked) => {
                    updateSettings({ planModeEnabled: Boolean(checked) });
                  }}
                  aria-label={gt("Plan mode (legacy)")}
                />
              }
            />
            <SettingsRow
              {...setting("legacy-context-window-indicator")}
              description={gt(
                "Shows context window usage as a circular indicator in the composer.",
              )}
              control={
                <Switch
                  checked={!settings.contextWindowMeterHidden}
                  onCheckedChange={(checked) =>
                    updateSettings({ contextWindowMeterHidden: !checked })
                  }
                  aria-label={gt("Context window indicator (legacy)")}
                />
              }
            />
          </SettingsGroup>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}
