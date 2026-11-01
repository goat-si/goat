/**
 * The mobile app's identity per build variant: what it is called, the URL schemes it registers,
 * and the store identifiers it ships under. app.config.ts, the app's link handling, and the
 * native build scripts all read from here, so renaming the app is one edit.
 *
 * Plain data with no React Native imports: Node scripts import this file directly.
 */

export type MobileAppVariant = "development" | "preview" | "production";

export interface MobileAppIdentity {
  readonly appName: string;
  readonly scheme: string;
  readonly iosBundleIdentifier: string;
  readonly androidPackage: string;
  /** Expo names the generated Xcode workspace, scheme, and .app after the app name without spaces. */
  readonly xcodeName: string;
}

export const MOBILE_APP_IDENTITY = {
  development: {
    appName: "GOAT Dev",
    scheme: "goat-dev",
    iosBundleIdentifier: "si.goat.mobile.dev",
    androidPackage: "si.goat.mobile.dev",
    xcodeName: "GOATDev",
  },
  preview: {
    appName: "GOAT Preview",
    scheme: "goat-preview",
    iosBundleIdentifier: "si.goat.mobile.preview",
    androidPackage: "si.goat.mobile.preview",
    xcodeName: "GOATPreview",
  },
  production: {
    appName: "GOAT",
    scheme: "goat",
    iosBundleIdentifier: "si.goat.mobile",
    androidPackage: "si.goat.mobile",
    xcodeName: "GOAT",
  },
} as const satisfies Record<MobileAppVariant, MobileAppIdentity>;

/** Every scheme a GOAT build registers; links may arrive on any of them. */
export const APP_SCHEMES = [
  MOBILE_APP_IDENTITY.production.scheme,
  MOBILE_APP_IDENTITY.development.scheme,
  MOBILE_APP_IDENTITY.preview.scheme,
] as const;

/**
 * The scheme widgets put in their tap URLs. iOS delivers a widget's URL to its containing app,
 * so the production scheme reaches development and preview builds too.
 */
export const PRODUCTION_SCHEME = MOBILE_APP_IDENTITY.production.scheme;

/** Apple Developer team that signs GOAT builds unless GOAT_IOS_TEAM_ID overrides it. */
export const DEFAULT_IOS_TEAM_ID = "U9ATA49N28";

/** True for a URL that is only a scheme (`goat://`, `goat-dev:///`), which wakes the app without a route. */
export function isSchemeOnlyUrl(url: string): boolean {
  const match = /^([a-z][a-z0-9+.-]*):\/*$/i.exec(url);
  return match !== null && (APP_SCHEMES as ReadonlyArray<string>).includes(match[1]!.toLowerCase());
}
