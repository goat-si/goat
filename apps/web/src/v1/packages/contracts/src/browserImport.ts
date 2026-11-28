import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { BrowserProfileId } from "./browserProfile.ts";

import { BrowserImportSourceId } from "./browserImportSourceId.ts";
export { BrowserImportSourceId } from "./browserImportSourceId.ts";

export const BrowserImportUnavailableReason = Schema.Literals([
  "notInstalled",
  "needsKeychainApproval",
  "keychainItemMissing",
  "needsFullDiskAccess",
  "browserRunning",
  "unsupportedPlatform",
  "appBoundEncryption",
]);
export type BrowserImportUnavailableReason = typeof BrowserImportUnavailableReason.Type;

export const BrowserImportFailureReason = Schema.Literals([
  ...BrowserImportUnavailableReason.literals,
  "keychainUnavailable",
  "unknownSource",
  "unknownSourceProfile",
  "sessionUnavailable",
  "profileNotSaved",
  "profileLimitReached",
  "readFailed",
]);
export type BrowserImportFailureReason = typeof BrowserImportFailureReason.Type;

export const BrowserImportSourceProfile = Schema.Struct({
  directory: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  cookieCount: Schema.optional(Schema.Int),
});
export type BrowserImportSourceProfile = typeof BrowserImportSourceProfile.Type;

export const BrowserImportSource = Schema.Struct({
  id: BrowserImportSourceId,
  name: TrimmedNonEmptyString,
  profiles: Schema.Array(BrowserImportSourceProfile),
  unavailable: Schema.optional(BrowserImportUnavailableReason),
  refreshUnavailable: Schema.optional(BrowserImportUnavailableReason),
});
export type BrowserImportSource = typeof BrowserImportSource.Type;

export const BrowserImportOrigin = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
    } catch {
      return false;
    }
  }),
);

export const BrowserImportInput = Schema.Struct({
  sourceId: BrowserImportSourceId,
  sourceProfileDirectory: TrimmedNonEmptyString,
  targetProfileId: BrowserProfileId,
  origins: Schema.optional(Schema.Array(BrowserImportOrigin)),
});
export type BrowserImportInput = typeof BrowserImportInput.Type;

export const DesktopPreviewImportCookiesInputSchema = Schema.Struct({
  environmentId: TrimmedNonEmptyString,
  sourceId: BrowserImportSourceId,
  sourceProfileDirectory: TrimmedNonEmptyString,
  targetProfileId: BrowserProfileId,
  origins: Schema.optional(Schema.Array(BrowserImportOrigin)),
});

export const BrowserImportResult = Schema.Struct({
  imported: Schema.Int,
  skipped: Schema.Int,
  skippedDomains: Schema.Array(Schema.String),
  origins: Schema.optional(
    Schema.Array(
      Schema.Struct({ origin: BrowserImportOrigin, imported: Schema.Int, skipped: Schema.Int }),
    ),
  ),
  sharedDomains: Schema.optional(Schema.Array(Schema.String)),
});
export type BrowserImportResult = typeof BrowserImportResult.Type;

const BROWSER_IMPORT_UNAVAILABLE_COPY: Readonly<Record<BrowserImportUnavailableReason, string>> = {
  notInstalled: "Not installed on this machine.",
  needsKeychainApproval: "Needs Keychain access to read its cookies.",
  keychainItemMissing:
    "No encryption key in your Keychain. Sign in to that browser once, then retry.",
  needsFullDiskAccess:
    "Give GOAT Full Disk Access in System Settings → Privacy & Security, then retry.",
  browserRunning: "Quit the browser first so its cookie database can be read.",
  unsupportedPlatform: "Importing from this browser isn't possible on this platform.",
  appBoundEncryption:
    "Chrome on Windows protects these cookies (app-bound encryption), so GOAT cannot read them. Sign in inside GOAT's browser instead.",
};

export const BROWSER_IMPORT_FAILURE_COPY: Readonly<Record<BrowserImportFailureReason, string>> = {
  ...BROWSER_IMPORT_UNAVAILABLE_COPY,
  keychainUnavailable:
    "The system keyring could not be accessed. Make sure your desktop keyring is running and unlocked, then retry.",
  unknownSource: "That browser is no longer available to import from.",
  unknownSourceProfile: "That browser profile no longer exists.",
  sessionUnavailable: "The target profile could not be opened.",
  profileNotSaved: "The cookies were imported, but the new profile couldn't be saved. Try again.",
  profileLimitReached:
    "You've reached the profile limit. Delete a profile or import into an existing one.",
  readFailed: "The browser's cookie database could not be read.",
};
