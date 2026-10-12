import type { EnvironmentId } from "@goat/contracts";
import type { ConnectionCatalogEntry, SshConnectionProfile } from "@goat/client-runtime/connection";
import { connectionRoutes, sshTargetKey } from "@goat/client-runtime/connection";
import * as Option from "effect/Option";
import type { DraftSshDestination } from "../composerDraftStore";

export interface SavedSshWorktreeOption {
  destination: DraftSshDestination;
  profile: SshConnectionProfile;
  label: string;
  disabledReason: string | null;
}
export function savedSshWorktreeOptions(
  entries: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>,
  desktopAvailable: boolean,
): SavedSshWorktreeOption[] {
  const candidates: SavedSshWorktreeOption[] = [];
  for (const [environmentId, entry] of entries) {
    for (const route of connectionRoutes(entry)) {
      const profile = Option.getOrNull(route.profile);
      if (route.target._tag !== "SshConnectionTarget" || profile?._tag !== "SshConnectionProfile")
        continue;
      // A saved profile is expected to identify its containing environment.
      if (
        profile.environmentId !== environmentId ||
        profile.connectionId !== route.target.connectionId
      )
        continue;
      candidates.push({
        destination: { connectionId: profile.connectionId, environmentId },
        profile,
        label: profile.label.trim() || entry.target.label || profile.target.alias,
        disabledReason: !desktopAvailable
          ? "SSH worktrees are available in the desktop app."
          : !entry.enabled
            ? "Enable this saved connection in Settings → Connections."
            : (entry.unsupportedReason ?? null),
      });
    }
  }
  // Enabled/usable route wins duplicates; stable tie-break makes choice deterministic.
  candidates.sort(
    (a, b) =>
      Number(a.disabledReason !== null) - Number(b.disabledReason !== null) ||
      a.label.localeCompare(b.label) ||
      a.destination.connectionId.localeCompare(b.destination.connectionId),
  );
  const seen = new Set<string>();
  return candidates.filter(({ profile }) => {
    const key = sshTargetKey(profile.target);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
export function findSavedSshWorktreeOption(
  options: ReadonlyArray<SavedSshWorktreeOption>,
  destination: DraftSshDestination | null | undefined,
): SavedSshWorktreeOption | null {
  if (!destination) return null;
  return (
    options.find(
      ({ destination: candidate }) =>
        candidate.connectionId === destination.connectionId &&
        candidate.environmentId === destination.environmentId,
    ) ?? null
  );
}
export function sshWorktreeSendBlockReason(input: {
  selected: boolean;
  draftAvailable: boolean;
  sourceIsPrimary: boolean;
  sourceProjectAvailable: boolean;
  sourceIsGitRepo: boolean;
  desktopAvailable: boolean;
  catalogReady: boolean;
  option: SavedSshWorktreeOption | null;
  canLaunch: boolean;
  hasAttachments: boolean;
  hasContextRecords: boolean;
  multipleModels: boolean;
}): string | null {
  if (!input.selected) return null;
  if (!input.draftAvailable) return "SSH worktrees need a new draft.";
  if (!input.desktopAvailable) return "SSH worktrees are available in the desktop app.";
  if (!input.sourceIsPrimary) return "Choose Local in Run on before sending to SSH.";
  if (!input.sourceProjectAvailable) return "Choose a local project before sending to SSH.";
  if (!input.sourceIsGitRepo) return "SSH worktrees need a Git project.";
  if (!input.catalogReady) return "Loading saved SSH connections.";
  if (!input.option) return "This saved SSH connection is unavailable. Choose another host.";
  if (input.option.disabledReason) return input.option.disabledReason;
  if (!input.canLaunch) return "This connection cannot copy code and start SSH threads.";
  if (input.multipleModels) return "Choose one model before sending to SSH.";
  if (input.hasAttachments) return "Remove attachments before sending to SSH.";
  if (input.hasContextRecords) return "Remove context chips before sending to SSH.";
  return null;
}

// Selection has the source restrictions, but attachments and catalog-route availability
// are send-time checks so disabled saved hosts remain inspectable in the submenu.
export function sshWorktreeSelectionBlockReason(input: {
  draftAvailable: boolean;
  sourceIsPrimary: boolean;
  sourceProjectAvailable: boolean;
  sourceIsGitRepo: boolean;
  desktopAvailable: boolean;
  canLaunch: boolean;
  multipleModels: boolean;
}): string | null {
  if (!input.draftAvailable) return "SSH worktrees need a new draft.";
  if (!input.desktopAvailable) return "SSH worktrees are available in the desktop app.";
  if (!input.sourceIsPrimary) return "Choose Local in Run on before sending to SSH.";
  if (!input.sourceProjectAvailable) return "Choose a local project before sending to SSH.";
  if (!input.sourceIsGitRepo) return "SSH worktrees need a Git project.";
  if (!input.canLaunch) return "This connection cannot copy code and start SSH threads.";
  if (input.multipleModels) return "Choose one model before sending to SSH.";
  return null;
}
