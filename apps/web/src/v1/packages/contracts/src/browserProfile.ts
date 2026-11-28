import * as Schema from "effect/Schema";
import { BrowserImportSourceId } from "./browserImportSourceId.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const BROWSER_PROFILE_NAME_MAX_LENGTH = 48;
export const BROWSER_PROFILE_MAX_COUNT = 24;

/** Control characters could collide with client cache-key delimiters and select another partition. */
export const BrowserProfileId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[^\p{Cc}]+$/u),
);
export type BrowserProfileId = typeof BrowserProfileId.Type;

export const BrowserProfileName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(BROWSER_PROFILE_NAME_MAX_LENGTH),
);

export const BrowserProfileKind = Schema.Literals(["persistent", "incognito"]);
export type BrowserProfileKind = typeof BrowserProfileKind.Type;

export const BrowserProfile = Schema.Struct({
  id: BrowserProfileId,
  name: BrowserProfileName,
  kind: BrowserProfileKind,
  importSource: Schema.optional(
    Schema.Struct({
      sourceId: BrowserImportSourceId,
      sourceProfileDirectory: TrimmedNonEmptyString,
    }),
  ),
});
export type BrowserProfile = typeof BrowserProfile.Type;

export const DEFAULT_BROWSER_PROFILE_ID: BrowserProfileId = "default";
export const INCOGNITO_BROWSER_PROFILE_ID: BrowserProfileId = "incognito";

export const BUILT_IN_BROWSER_PROFILES: ReadonlyArray<BrowserProfile> = [
  { id: DEFAULT_BROWSER_PROFILE_ID, name: "Default", kind: "persistent" },
  { id: INCOGNITO_BROWSER_PROFILE_ID, name: "Incognito", kind: "incognito" },
];

export function isBuiltInBrowserProfileId(id: string): boolean {
  return BUILT_IN_BROWSER_PROFILES.some((profile) => profile.id === id);
}

/** Deduplicates ids sharing a partition; only the built-in incognito id is actually ephemeral. */
export function resolveBrowserProfiles(
  userProfiles: ReadonlyArray<BrowserProfile>,
): ReadonlyArray<BrowserProfile> {
  const seen = new Set(BUILT_IN_BROWSER_PROFILES.map((profile) => profile.id));
  const resolved = BUILT_IN_BROWSER_PROFILES.map((profile) => {
    const saved = userProfiles.find((candidate) => candidate.id === profile.id);
    return saved?.importSource && profile.kind === "persistent"
      ? { ...profile, importSource: saved.importSource }
      : profile;
  });
  for (const profile of userProfiles) {
    if (seen.has(profile.id)) continue;
    seen.add(profile.id);
    resolved.push(profile.kind === "persistent" ? profile : { ...profile, kind: "persistent" });
  }
  return resolved;
}

export function findBrowserProfile(
  profiles: ReadonlyArray<BrowserProfile>,
  id: string | undefined,
): BrowserProfile | undefined {
  return id === undefined ? undefined : profiles.find((profile) => profile.id === id);
}
