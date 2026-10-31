import {
  BrowserImportFailureReason,
  BROWSER_PROFILE_MAX_COUNT,
  resolveBrowserProfiles,
  type BrowserImportSource,
  type EnvironmentId,
} from "@goat/contracts";
import { previewBridge } from "~/components/preview/previewBridge";
import { getClientSettings, persistClientSettingsUpdate } from "~/hooks/useSettings";
import type { WizardTarget } from "./BrowserImportWizard";
import type { ImportOutcome } from "./browserImportWizard.logic";

/** IPC carries reason tokens inside messages; treat unknown tokens as read failures without exposing raw
 * text. */
class ProfileLimitReachedError extends Error {
  constructor() {
    super("Browser profile limit reached.");
    this.name = "ProfileLimitReachedError";
  }
}

export const importFailureReason = (cause: unknown): BrowserImportFailureReason => {
  const message = String((cause as { message?: unknown } | undefined)?.message ?? "");
  return (
    BrowserImportFailureReason.literals.find((reason) => message.includes(`failed: ${reason}.`)) ??
    "readFailed"
  );
};

export async function importBrowserCookiesIntoTarget(
  bridge: NonNullable<typeof previewBridge>,
  source: BrowserImportSource,
  environmentId: EnvironmentId,
  input: { readonly sourceProfileDirectory: string; readonly target: WizardTarget },
  clearNewProfile: (profileId: string) => Promise<void>,
): Promise<ImportOutcome> {
  try {
    const result = await bridge.importBrowserCookies({
      environmentId,
      sourceId: source.id,
      sourceProfileDirectory: input.sourceProfileDirectory,
      targetProfileId: input.target.profileId,
    });
    if (
      input.target.kind === "existing" &&
      !resolveBrowserProfiles(getClientSettings().browserProfiles).some(
        (profile) => profile.id === input.target.profileId,
      )
    ) {
      return { kind: "blocked", reason: "readFailed" };
    }
    let targetName: string;
    if (input.target.kind === "new") {
      if (result.imported > 0) {
        try {
          const persisted = await persistClientSettingsUpdate((current) => {
            const existing = current.browserProfiles.find(
              (profile) => profile.id === input.target.profileId,
            );
            if (existing) return current;
            // The profile cap may be reached during import; enforce it against the updater's latest settings.
            if (current.browserProfiles.length >= BROWSER_PROFILE_MAX_COUNT) {
              throw new ProfileLimitReachedError();
            }
            const taken = new Set(
              resolveBrowserProfiles(current.browserProfiles).map((profile) => profile.name),
            );
            let name = source.name;
            for (let index = 2; taken.has(name); index += 1) name = `${source.name} ${index}`;
            return {
              ...current,
              browserProfiles: [
                ...current.browserProfiles,
                {
                  id: input.target.profileId,
                  name,
                  kind: "persistent" as const,
                  importSource: {
                    sourceId: source.id,
                    sourceProfileDirectory: input.sourceProfileDirectory,
                  },
                },
              ],
            };
          });
          targetName =
            persisted.browserProfiles.find((profile) => profile.id === input.target.profileId)
              ?.name ?? source.name;
        } catch (cause) {
          // Clear the new target's partition on registration failure so imported cookies cannot outlive its
          // profile.
          await clearNewProfile(input.target.profileId).catch(() => undefined);
          const reason =
            cause instanceof ProfileLimitReachedError ? "profileLimitReached" : "profileNotSaved";
          throw new Error(`Importing cookies from ${source.id} failed: ${reason}.`, { cause });
        }
      } else {
        targetName = source.name;
      }
    } else {
      targetName = input.target.name;
      if (result.imported > 0) {
        await persistClientSettingsUpdate((current) => {
          const existing = resolveBrowserProfiles(current.browserProfiles).find(
            (profile) => profile.id === input.target.profileId,
          );
          if (!existing || existing.kind !== "persistent") return current;
          const linked = {
            ...existing,
            importSource: {
              sourceId: source.id,
              sourceProfileDirectory: input.sourceProfileDirectory,
            },
          };
          return {
            ...current,
            browserProfiles: [
              ...current.browserProfiles.filter((profile) => profile.id !== existing.id),
              linked,
            ],
          };
        }).catch((cause) => {
          throw new Error(`Importing cookies from ${source.id} failed: profileNotSaved.`, {
            cause,
          });
        });
      }
    }
    return {
      kind: "imported",
      imported: result.imported,
      skipped: result.skipped,
      skippedDomains: result.skippedDomains,
      targetName,
    };
  } catch (cause) {
    return { kind: "blocked", reason: importFailureReason(cause) };
  }
}
