import { useGT } from "gt-react";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";
import { useTranslatedSearchableSetting } from "./useTranslatedSearchableSetting";

// GOAT's own build (si.goat.mobile) has no store listing yet, and the store listings are
// upstream's app, so this points at the guide that says what can be installed today.
const MOBILE_INSTALL_GUIDE = "https://trygoat.ai/docs/user/install#mobile-app";

export function MobileAppSettingsRow() {
  const setting = useTranslatedSearchableSetting();
  const gt = useGT();
  return (
    <SettingsRow
      {...setting("mobile-app")}
      description={gt(
        "GOAT for iPhone, iPad and Android is not in the App Store or Google Play yet.",
      )}
      control={
        <Button
          size="sm"
          variant="outline"
          render={<a href={MOBILE_INSTALL_GUIDE} target="_blank" rel="noreferrer noopener" />}
        >
          {gt("How to install")}
        </Button>
      }
    />
  );
}
