import { parseSemver } from "@goat/shared/semver";

import { APP_VERSION, HOSTED_APP_CHANNEL } from "../branding";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { AndroidIcon, AppleIcon } from "./Icons";
import { SettingsRow } from "./settings/settingsLayout";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "./ui/popover";
import { QRCodeSvg } from "./ui/qr-code";

// Orchestrator V2 ships to Nightly first. The App Store and Google Play apps are
// still V1 and cannot connect to a V2 server, so Nightly users need the V2 beta
// app. Delete this file when the store apps move to V2. See #14871.

/** True on Nightly desktop, server, and hosted app builds. */
export const IS_NIGHTLY_BUILD =
  parseSemver(APP_VERSION)?.prerelease[0] === "nightly" || HOSTED_APP_CHANNEL === "nightly";

/**
 * GOAT's iOS TestFlight invite. GOAT has no public beta yet, so this is null and
 * the Settings row stays hidden. Set it to show the row again.
 */
export const GOAT_IOS_TESTFLIGHT_URL: string | null = null;

/** Whether a build should advertise the beta mobile app. */
export function shouldShowNightlyMobileBeta(input: {
  isNightly: boolean;
  testflightUrl: string | null | undefined;
}): boolean {
  return input.isNightly && Boolean(input.testflightUrl);
}

/** True when the beta mobile app has a GOAT TestFlight link to point at. */
export const HAS_MOBILE_BETA_LINK = Boolean(GOAT_IOS_TESTFLIGHT_URL);

// Google banned the Play testing group, so new testers can't join it. CI mirrors
// the Play-signed beta APK to this release instead (mobile-android-apk.yml).
const ANDROID_APK_RELEASE_URL = "https://github.com/pingdotgg/t3code/releases/tag/android-nightly";

const ROW_ID = "nightly-mobile-beta";
/** QR code plus a copy button for one beta link. */
function BetaLinkQr({ url, label }: { url: string; label: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="rounded-lg bg-white p-1.5">
        <QRCodeSvg value={url} size={128} level="M" marginSize={1} title={label} />
      </div>
      <Button size="xs" variant="outline" onClick={() => copyToClipboard(url)}>
        {isCopied ? "Copied" : "Copy link"}
      </Button>
    </div>
  );
}

/**
 * Settings → General → About row with the beta app links. Render it only for
 * Nightly; it renders nothing until GOAT has a TestFlight link.
 */
export function NightlyMobileBetaRow() {
  const testflightUrl = GOAT_IOS_TESTFLIGHT_URL;
  if (!testflightUrl) return null;
  return (
    <SettingsRow
      id={ROW_ID}
      title="Mobile app"
      description="Nightly needs the beta app. The App Store and Google Play versions cannot connect."
      control={
        <div className="flex items-center gap-2">
          <Popover>
            <PopoverTrigger render={<Button size="sm" variant="outline" />}>
              <AppleIcon />
              iPhone
            </PopoverTrigger>
            <PopoverPopup align="end">
              <div className="flex flex-col gap-3">
                <div className="space-y-1">
                  <PopoverTitle>TestFlight beta</PopoverTitle>
                  <p className="text-xs text-muted-foreground">Scan with your iPhone camera.</p>
                </div>
                <BetaLinkQr url={testflightUrl} label="TestFlight beta link" />
              </div>
            </PopoverPopup>
          </Popover>
          <Popover>
            <PopoverTrigger render={<Button size="sm" variant="outline" />}>
              <AndroidIcon />
              Android
            </PopoverTrigger>
            <PopoverPopup align="end">
              <div className="flex flex-col gap-3">
                <div className="space-y-1">
                  <PopoverTitle>Android beta APK</PopoverTitle>
                  <p className="max-w-56 text-xs text-muted-foreground">
                    Scan with your phone, then download and install the APK.
                  </p>
                </div>
                <BetaLinkQr url={ANDROID_APK_RELEASE_URL} label="Android beta APK link" />
              </div>
            </PopoverPopup>
          </Popover>
        </div>
      }
    />
  );
}
