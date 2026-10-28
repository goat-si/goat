import * as Schema from "effect/Schema";

import { BrowserProfileId } from "./browserProfile.ts";
import { PreviewTabId } from "./preview.ts";

/** isolated: a fresh per-tab context with no saved sign-ins. profile: a GOAT-owned persistent profile. */
export const PreviewSessionMode = Schema.Literals(["isolated", "profile"]);
export type PreviewSessionMode = typeof PreviewSessionMode.Type;

/** Where a tab's cookies live: the server browser's profile folder or the desktop app's partition. */
export const PreviewSessionStore = Schema.Literals(["server", "desktop"]);
export type PreviewSessionStore = typeof PreviewSessionStore.Type;

export const PreviewTabSession = Schema.Struct({
  mode: PreviewSessionMode,
  profileId: Schema.optional(BrowserProfileId),
  store: PreviewSessionStore,
});
export type PreviewTabSession = typeof PreviewTabSession.Type;

export const PREVIEW_SESSION_GUIDANCE =
  "isolated (default): a fresh tab with no saved sign-ins. profile: a GOAT profile a person signed in to inside GOAT; pass profileId when more than one exists. Never switches to the other mode.";

export const PreviewSignInField = Schema.Literals(["filled", "empty", "absent"]);
export type PreviewSignInField = typeof PreviewSignInField.Type;

export const PreviewSignInStage = Schema.Literals([
  "human_step",
  "account_choice",
  "validation_error",
  "partial",
  "fields_applied",
  "form_present",
  "submitted",
  "site_accepted",
  "signed_in",
  "unknown",
]);
export type PreviewSignInStage = typeof PreviewSignInStage.Type;

const Short = Schema.String.check(Schema.isMaxLength(200));

/**
 * What GOAT observed about a sign-in on this tab. Each fact is separate: a filled password with an
 * empty identifier is partial, and signed_in needs the submitted identifier shown afterwards.
 */
export const PreviewAutomationSignInState = Schema.Struct({
  stage: PreviewSignInStage,
  origin: Schema.NullOr(Schema.String),
  session: Schema.optional(PreviewTabSession),
  fields: Schema.Struct({ identifier: PreviewSignInField, password: PreviewSignInField }),
  submitted: Schema.Boolean,
  humanStep: Schema.optional(Schema.Literals(["captcha", "mfa", "passkey"])),
  validation: Schema.Array(Short).check(Schema.isMaxLength(3)),
  evidence: Schema.Array(Short).check(Schema.isMaxLength(8)),
});
export type PreviewAutomationSignInState = typeof PreviewAutomationSignInState.Type;

export const PreviewAutomationSignInStateInput = Schema.Struct({
  tabId: Schema.optional(PreviewTabId),
});
export type PreviewAutomationSignInStateInput = typeof PreviewAutomationSignInStateInput.Type;

export const PROFILE_GUIDANCE =
  "Profile id or name from goat_preview_status, for a new tab; implies session profile. A tab keeps its profile.";

export const PreviewAutomationProfile = Schema.Struct({
  id: BrowserProfileId,
  name: Schema.String,
  incognito: Schema.optional(Schema.Boolean),
});
export type PreviewAutomationProfile = typeof PreviewAutomationProfile.Type;

/** The open input's combinations that cannot mean one thing. */
export const openInputRule = Schema.makeFilter(
  (input: {
    readonly tabId?: string | undefined;
    readonly reuseExistingTab?: boolean | undefined;
    readonly session?: PreviewSessionMode | undefined;
    readonly profileId?: string | undefined;
  }) =>
    input.tabId !== undefined && input.reuseExistingTab === false
      ? "tabId cannot be combined with reuseExistingTab=false."
      : input.session !== "isolated" ||
        input.profileId === undefined ||
        "profileId selects a saved profile; omit it for session isolated.",
);
