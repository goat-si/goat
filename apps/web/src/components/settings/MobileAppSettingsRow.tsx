import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

// GOAT's own build (si.goat.mobile) has no store listing yet, and the store listings are
// upstream's app, so this points at the guide that says what can be installed today.
const MOBILE_INSTALL_GUIDE =
  "https://github.com/goat-si/goat/blob/dev/docs/user/install.md#mobile-app";

export function MobileAppSettingsRow() {
  return (
    <SettingsRow
      {...searchableSetting("mobile-app")}
      description="GOAT for iPhone, iPad and Android is not in the App Store or Google Play yet."
      control={
        <Button
          size="sm"
          variant="outline"
          render={<a href={MOBILE_INSTALL_GUIDE} target="_blank" rel="noreferrer noopener" />}
        >
          How to install
        </Button>
      }
    />
  );
}
