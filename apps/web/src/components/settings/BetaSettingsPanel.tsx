import { useAuth } from "@clerk/react";
import { DEFAULT_UNIFIED_SETTINGS } from "@goat/contracts/settings";
import { Link } from "@tanstack/react-router";
import { useGT } from "gt-react";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useGoatConnectAuthPrompt } from "../clerk/useGoatConnectAuthPrompt";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { ScopedSwitch } from "./ScopedSwitch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useTranslatedSearchableSetting } from "./useTranslatedSearchableSetting";
import { ToolCallVisibilityRow } from "./ToolCallVisibilityRow";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/** Features that are still settling in. Some are on by default; each can be turned off here. */
export function BetaSettingsPanel() {
  const gt = useGT();
  const setting = useTranslatedSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const workingShelf = setting("working-shelf");
  return (
    <SettingsPageContainer>
      <SettingsSection id="beta" title={gt("Beta")}>
        <SettingsRow
          {...setting("new-design")}
          description={gt(
            "A true black dark mode, dimmer read threads, and simpler composer controls. Turn it off for the classic look.",
          )}
          resetAction={
            settings.redesignEnabled !== DEFAULT_UNIFIED_SETTINGS.redesignEnabled ? (
              <SettingResetButton
                label={setting("new-design").title}
                onClick={() =>
                  updateSettings({ redesignEnabled: DEFAULT_UNIFIED_SETTINGS.redesignEnabled })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.redesignEnabled}
              onCheckedChange={(checked) => updateSettings({ redesignEnabled: Boolean(checked) })}
              aria-label={gt("New design")}
            />
          }
        />
        <SettingsRow
          {...workingShelf}
          description={gt(
            "Order active threads by when each last came back to you. Running work stays in Priority.",
          )}
          resetAction={
            settings.sidebarWorkingShelfEnabled !==
            DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled ? (
              <SettingResetButton
                label={workingShelf.title}
                onClick={() =>
                  updateSettings({
                    sidebarWorkingShelfEnabled: DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.sidebarWorkingShelfEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ sidebarWorkingShelfEnabled: Boolean(checked) })
              }
              aria-label={gt("Working section")}
            />
          }
        />
        <ToolCallVisibilityRow />
        {/* Clerk is only mounted when this build has GOAT Connect. */}
        {hasCloudPublicConfig() ? <GuestLinksRowWithSignIn /> : <GuestLinksRow />}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

/** Signed out of GOAT Connect, the row offers to sign in instead of its switch. */
function GuestLinksRowWithSignIn() {
  const gt = useGT();
  const setting = useTranslatedSearchableSetting();
  const { isSignedIn } = useAuth();
  const { openAuthPrompt } = useGoatConnectAuthPrompt();
  // `isSignedIn` is undefined until Clerk loads.
  if (isSignedIn !== false) return <GuestLinksRow />;
  return (
    <SettingsRow
      {...setting("guest-links")}
      description={
        <>
          {gt(
            "Share a thread with a guest who watches it live in their browser and sends messages you approve.",
          )}{" "}
          {gt("Sign in to GOAT Connect to use guest links.")}
        </>
      }
      control={
        <Button size="sm" variant="outline" onClick={openAuthPrompt}>
          {gt("Sign in")}
        </Button>
      }
    />
  );
}

function GuestLinksRow() {
  const gt = useGT();
  const setting = useTranslatedSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      {...setting("guest-links")}
      settingKeys={["guestSharingEnabled"]}
      description={
        <>
          {gt(
            "Share a thread with a guest who watches it live in their browser and sends messages you approve.",
          )}{" "}
          {gt(
            "To use guest links, sign in to GOAT Connect and link this machine. Turning this off disables every guest link.",
          )}{" "}
          <Link to="/settings/connections" className="underline underline-offset-2">
            {gt("Open Connections")}
          </Link>
        </>
      }
      control={
        <ScopedSwitch
          settingKeys={["guestSharingEnabled"]}
          checked={settings.guestSharingEnabled}
          onCheckedChange={(checked) => updateSettings({ guestSharingEnabled: Boolean(checked) })}
          aria-label={setting("guest-links").title}
        />
      }
    />
  );
}
