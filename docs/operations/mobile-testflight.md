# Mobile beta builds

Testers join from [trygoat.ai/mobile](https://trygoat.ai/mobile/): iPhone and iPad through TestFlight,
Android through Firebase App Distribution. Both invite links are public and live in
[`links.ts`](../../apps/marketing/src/lib/links.ts).

## iOS: TestFlight

GOAT's iOS app is archived and uploaded from a Mac with Xcode, signed by the GOAT Apple Developer
team (`U9ATA49N28`). [`scripts/mobile-testflight.ts`](../../scripts/mobile-testflight.ts) runs the
whole path; the bundle ids and names come from
[`mobileAppIdentity.ts`](../../packages/shared/src/mobileAppIdentity.ts).

| Variant    | App name     | iOS bundle id            |
| ---------- | ------------ | ------------------------ |
| production | GOAT         | `si.goat.mobile`         |
| preview    | GOAT Preview | `si.goat.mobile.preview` |

### Once per Mac and per app

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

### Each build

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

## Android: Firebase App Distribution

Android beta builds go to Firebase App Distribution in the Firebase project `goat-mobile-6c1ed`
(owned by jun@lidgeai.com, free Spark plan), Android app `si.goat.mobile`, tester group
`beta-testers`. Google Play testing waits on a Play developer account
([#3057](https://github.com/goat-si/goat/issues/3057)).

Every build must be signed with the same GOAT beta key, or testers have to uninstall before they can
update. The keystore is `~/Library/Application Support/goat-mobile-android/goat-beta.keystore` on
Jun's home Mac (macbookpro-2), alias `goat-beta`; its password is the Keychain item
`goat-android-beta-keystore`. Keep a backup of both outside the repository.

### Once per Mac

Install JDK 17 and the Android command-line tools (`brew install openjdk@17` and
`brew install --cask android-commandlinetools`), then accept the SDK licenses with
`sdkmanager --sdk_root=$HOME/Library/Android/sdk --licenses`. Gradle downloads the platform, build
tools and NDK it needs on the first build.

### Each build

From `apps/mobile`, with `JAVA_HOME=/opt/homebrew/opt/openjdk@17` and
`ANDROID_HOME=$HOME/Library/Android/sdk`:

```bash
export APP_VARIANT=production GOAT_MOBILE_VERSION=3.0.0 GOAT_MOBILE_BUILD_NUMBER=$(( $(date +%s) / 60 ))
EXPO_NO_GIT_STATUS=1 npx expo prebuild --clean --platform android --no-install
(cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a,x86_64)
apksigner sign --ks "$HOME/Library/Application Support/goat-mobile-android/goat-beta.keystore" \
  --ks-key-alias goat-beta --ks-pass "pass:$(security find-generic-password -s goat-android-beta-keystore -w)" \
  --out goat-beta.apk android/app/build/outputs/apk/release/app-release.apk
```

`GOAT_MOBILE_BUILD_NUMBER` becomes the Android `versionCode`, which must grow with each build.
`apksigner` is in `$ANDROID_HOME/build-tools/<version>/`. Upload `goat-beta.apk` in the Firebase
console under **App Distribution → Releases**, add the **Beta testers** group and a short release
note, and distribute. Testers get an email and see the build in the invite link's tester page.

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
