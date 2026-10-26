# Mobile TestFlight builds

GOAT's iOS app is archived and uploaded from a Mac with Xcode, signed by the GOAT Apple Developer
team (`U9ATA49N28`). [`scripts/mobile-testflight.ts`](../../scripts/mobile-testflight.ts) runs the
whole path; the bundle ids and names come from
[`mobileAppIdentity.ts`](../../packages/shared/src/mobileAppIdentity.ts).

| Variant    | App name     | iOS bundle id            |
| ---------- | ------------ | ------------------------ |
| production | GOAT         | `si.goat.mobile`         |
| preview    | GOAT Preview | `si.goat.mobile.preview` |

## Once per Mac and per app

1. Sign in to Xcode with an Apple account in the team: **Xcode > Settings > Accounts > + > Apple
   Account**. The script checks that the team shows up there. Instead of an account you can use an
   App Store Connect API key (App Manager or Admin role): set `ASC_KEY_PATH` (the `.p8` file),
   `ASC_KEY_ID` and `ASC_ISSUER_ID`. Keep the key outside the repository.
2. Install CocoaPods (`brew install cocoapods`).
3. Register at least one iPhone with the team. Automatic signing archives with a development profile
   before the export re-signs for the App Store, and Apple creates a development profile only for a
   team with a registered device. Connect an unlocked iPhone to the Mac by cable and trust it; the
   script passes `-allowProvisioningDeviceRegistration`, so the first archive registers it. Without
   one the archive stops with "Your team has no devices from which to generate a provisioning
   profile".
4. Create the app record in [App Store Connect](https://appstoreconnect.apple.com/apps): **Apps > + >
   New App**, platform iOS, name GOAT, bundle id `si.goat.mobile`, any SKU. The bundle id appears in
   the list after the first archive registers it through automatic signing; if it does not, register
   it under **Certificates, Identifiers & Profiles > Identifiers**. An upload to a bundle id without an
   app record fails.

Automatic signing creates the Apple Distribution certificate and the App Store profiles for the app,
the widget (`.widgets`), the share extension (`.sharing`) and their app group on the first archive.

## Each build

From the repository root:

```bash
node scripts/mobile-testflight.ts                 # production: archive and upload
node scripts/mobile-testflight.ts --variant preview
node scripts/mobile-testflight.ts --simulator     # unsigned simulator Release build, no account
node scripts/mobile-testflight.ts --export-only   # signed IPA in apps/mobile/.testflight, no upload
```

The build number defaults to minutes since the Unix epoch. Two runs in the same minute get the same
number, and App Store Connect rejects a repeated number, so pass a higher `--build-number` to retry.
The script refuses an archive whose app or extensions carry another bundle id or build number.

After the upload, App Store Connect processes the build for a few minutes. Members of the team see it
in the TestFlight app once it is added to an internal testing group (**TestFlight > Internal Testing**);
internal testing needs no Beta App Review.

## Services left off

The mobile app leaves services that need accounts it does not have switched off:

- **OTA updates** need `GOAT_MOBILE_EAS_PROJECT_ID` (and `GOAT_MOBILE_EAS_OWNER` for EAS builds).
  Without them updates are disabled. `GOAT_MOBILE_UPDATES_ENABLED=0` turns them off for a project too.
- **Connect sign-in** is off in every build until GOAT Connect ships; when enabled it needs the Clerk and relay settings described in the
  [mobile README](../../apps/mobile/README.md). Sign in with Apple is requested only when a Clerk key
  is set, and passkey/universal-link domains only when `GOAT_MOBILE_CLERK_DOMAIN` names a domain the
  team serves an apple-app-site-association file for.
- **Remote push** registers through the relay, so without a relay URL the app does not register a push
  token. Push notifications and Live Activities stay unavailable until GOAT Connect ships.
