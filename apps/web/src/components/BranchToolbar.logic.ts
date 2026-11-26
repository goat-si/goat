import { msg } from "gt-react";
import { workspaceRelativeFilePath } from "@goat/shared/path";
import type {
  EnvironmentId,
  EnvironmentMachineKind,
  VcsRef,
  ProjectId,
  WorktreeSubmodules,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { sanitizeNewRefName } from "@goat/shared/git";
import type { ThreadStructureRuntime } from "@goat/client-runtime/state/shell";
import { deriveCanInterruptRunningThread } from "../session-logic";
export {
  dedupeRemoteBranchesWithLocalMatches,
  deriveLocalBranchNameFromRemoteRef,
  sanitizeNewRefName,
} from "@goat/shared/git";

export interface EnvironmentOption {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  label: string;
  isPrimary: boolean;
  machine: EnvironmentMachineKind;
}

/** "Add to another machine" stays muted until hovered: easy to find, quieter than the machines. */
export const ADD_TO_MACHINE_LABEL_CLASS =
  "flex min-w-0 items-center gap-1.5 opacity-55 in-data-highlighted:opacity-100 in-data-popup-open:opacity-100";

export const EnvMode = Schema.Literals(["local", "worktree"]);
export type EnvMode = typeof EnvMode.Type;

const GENERIC_LOCAL_ENVIRONMENT_LABELS = new Set(["local", "local environment"]);

/** The primary environment's name when it has no specific one. Translated sentences swap it in. */
const PRIMARY_ENVIRONMENT_FALLBACK_LABEL = "This device";

export const localizeEnvironmentLabel = (label: string, thisDevice: string): string =>
  label === PRIMARY_ENVIRONMENT_FALLBACK_LABEL ? thisDevice : label;

function normalizeDisplayLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function resolveEnvironmentOptionLabel(input: {
  isPrimary: boolean;
  environmentId: EnvironmentId;
  runtimeLabel?: string | null;
  savedLabel?: string | null;
}): string {
  const runtimeLabel = normalizeDisplayLabel(input.runtimeLabel);
  const savedLabel = normalizeDisplayLabel(input.savedLabel);

  if (input.isPrimary) {
    const preferredLocalLabel = [runtimeLabel, savedLabel].find((label) => {
      if (!label) return false;
      return !GENERIC_LOCAL_ENVIRONMENT_LABELS.has(label.toLowerCase());
    });
    return preferredLocalLabel ?? PRIMARY_ENVIRONMENT_FALLBACK_LABEL;
  }

  return runtimeLabel ?? savedLabel ?? input.environmentId;
}

export function shouldShowEnvironmentIndicator(input: {
  activeEnvironment: Pick<EnvironmentOption, "isPrimary"> | null;
  canPickEnvironment: boolean;
}): boolean {
  if (input.canPickEnvironment) return true;
  return input.activeEnvironment !== null && !input.activeEnvironment.isPrimary;
}

export function shouldShowComposerContextStrip(input: {
  isDraftHeroState: boolean;
  persistInActiveThreads: boolean;
  hasActiveProject: boolean;
  isGitRepo: boolean;
  showEnvironmentIndicator: boolean;
  hostsRestingComposerControls: boolean;
}): boolean {
  return (
    input.hasActiveProject &&
    (input.isDraftHeroState || input.persistInActiveThreads) &&
    (input.isGitRepo || input.showEnvironmentIndicator || input.hostsRestingComposerControls)
  );
}

// Hysteresis prevents labels and icons from flapping at the width boundary.
const CONTEXT_STRIP_COMPACT_EXPAND_HYSTERESIS_PX = 16;

export function resolveContextStripLabelsCompact(input: {
  compact: boolean;
  neededWidth: number;
  availableWidth: number;
}): boolean {
  return input.compact
    ? input.neededWidth > input.availableWidth - CONTEXT_STRIP_COMPACT_EXPAND_HYSTERESIS_PX
    : input.neededWidth > input.availableWidth;
}

export function resolveEnvModeLabel(mode: EnvMode): string {
  return mode === "worktree" ? msg("New worktree") : msg("Local");
}

export const WORKTREE_SUBMODULES_LABELS: Record<WorktreeSubmodules, string> = {
  recursive: msg("Recursive"),
  "top-level": msg("Top level only"),
  none: msg("Skip"),
};

export function resolveCurrentWorkspaceLabel(activeWorktreePath: string | null): string {
  return activeWorktreePath ? "Worktree" : resolveEnvModeLabel("local");
}

// A locked thread in worktree mode with no path is still creating its
// worktree, so it reads as a new worktree rather than the project checkout.
export function resolveWorkspaceChipLabel(input: {
  activeWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
  forceNewWorktree?: boolean;
  activeEnvironment?: Pick<EnvironmentOption, "isPrimary" | "label"> | null;
}): string {
  const modeLabel = input.forceNewWorktree
    ? resolveEnvModeLabel("worktree")
    : input.activeWorktreePath
      ? resolveCurrentWorkspaceLabel(input.activeWorktreePath)
      : resolveEnvModeLabel(input.effectiveEnvMode);
  return input.activeEnvironment && !input.activeEnvironment.isPrimary
    ? `${modeLabel} · ${input.activeEnvironment.label}`
    : modeLabel;
}

export function resolveEffectiveEnvMode(input: {
  activeWorktreePath: string | null;
  hasServerThread: boolean;
  draftThreadEnvMode: EnvMode | undefined;
  preparingWorktree?: boolean;
}): EnvMode {
  const { activeWorktreePath, hasServerThread, draftThreadEnvMode, preparingWorktree } = input;
  if (!hasServerThread) {
    if (activeWorktreePath) {
      return "local";
    }
    return draftThreadEnvMode === "worktree" ? "worktree" : "local";
  }
  return activeWorktreePath || preparingWorktree ? "worktree" : "local";
}

export function resolveDraftEnvModeAfterBranchChange(input: {
  nextWorktreePath: string | null;
  currentWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
}): EnvMode {
  const { nextWorktreePath, currentWorktreePath, effectiveEnvMode } = input;
  if (nextWorktreePath) {
    return "worktree";
  }
  if (effectiveEnvMode === "worktree" && !currentWorktreePath) {
    return "worktree";
  }
  return "local";
}

export function resolveBranchToolbarValue(input: {
  envMode: EnvMode;
  activeWorktreePath: string | null;
  activeThreadBranch: string | null;
  currentGitBranch: string | null;
}): string | null {
  const { envMode, activeWorktreePath, activeThreadBranch, currentGitBranch } = input;
  if (envMode === "worktree" && !activeWorktreePath) {
    return activeThreadBranch ?? currentGitBranch;
  }
  return currentGitBranch ?? activeThreadBranch;
}

export interface BranchHold {
  readonly branch: string | null;
  readonly environmentId: EnvironmentId;
  /**
   * Each checkout the thread can show before it catches up, with the branch its status reported
   * before the switch. A move from a worktree to the project root lists both.
   */
  readonly checkouts: ReadonlyArray<{ readonly cwd: string; readonly replaces: string | null }>;
}

/**
 * A finished checkout's branch stays on screen until status reports any change, because the status
 * stream and the RPC reply are not ordered and showing status first would flip back to the old branch.
 */
export function isBranchHoldCurrent(
  hold: BranchHold,
  current: {
    readonly canonicalBranch: string | null;
    readonly environmentId: EnvironmentId;
    readonly cwd: string | null;
  },
): boolean {
  return (
    hold.environmentId === current.environmentId &&
    hold.checkouts.some(
      (checkout) => checkout.cwd === current.cwd && checkout.replaces === current.canonicalBranch,
    )
  );
}

/**
 * The base a New worktree thread gets without the user picking one. Only a listed ref qualifies:
 * during a clone the status names an unborn HEAD that no ref backs.
 */
export function resolveDefaultWorktreeBaseBranch(
  refs: ReadonlyArray<Pick<VcsRef, "name" | "isDefault" | "current">>,
): string | null {
  return (refs.find((ref) => ref.isDefault) ?? refs.find((ref) => ref.current))?.name ?? null;
}

export function resolveBranchTriggerLabel(input: {
  activeWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
  resolvedActiveBranch: string | null;
  resolvedActiveBranchIsRemote: boolean | null;
  startFromOrigin: boolean;
}): string {
  const {
    activeWorktreePath,
    effectiveEnvMode,
    resolvedActiveBranch,
    resolvedActiveBranchIsRemote,
    startFromOrigin,
  } = input;
  if (!resolvedActiveBranch) {
    return "Select ref";
  }
  if (effectiveEnvMode === "worktree" && !activeWorktreePath) {
    // Only the server can determine a local branch's configured remote.
    return startFromOrigin && resolvedActiveBranchIsRemote === false
      ? `From ${resolvedActiveBranch} (remote)`
      : `From ${resolvedActiveBranch}`;
  }
  return resolvedActiveBranch;
}

export function resolveBranchToolbarPrBranch(input: {
  activeThreadBranch: string | null;
  resolvedActiveBranch: string | null;
}): string | null {
  return input.activeThreadBranch === input.resolvedActiveBranch ? input.activeThreadBranch : null;
}

export function resolveLocalCheckoutBranchMismatch(input: {
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  activeThreadBranch: string | null;
  currentGitBranch: string | null;
}): { threadBranch: string; currentBranch: string } | null {
  const { effectiveEnvMode, activeWorktreePath, activeThreadBranch, currentGitBranch } = input;
  if (effectiveEnvMode !== "local" || activeWorktreePath !== null) {
    return null;
  }
  if (!activeThreadBranch || !currentGitBranch || activeThreadBranch === currentGitBranch) {
    return null;
  }
  return { threadBranch: activeThreadBranch, currentBranch: currentGitBranch };
}

export function resolveBranchSelectionTarget(input: {
  activeProjectCwd: string;
  activeProjectCheckoutRoot?: string | undefined;
  activeWorktreePath: string | null;
  refName: Pick<VcsRef, "isDefault" | "worktreePath">;
}): {
  checkoutCwd: string;
  nextWorktreePath: string | null;
  reuseExistingWorktree: boolean;
  staysInActiveCheckout: boolean;
} {
  const { activeProjectCwd, activeWorktreePath, refName } = input;

  if (refName.worktreePath) {
    const isProjectCheckout =
      input.activeProjectCheckoutRoot === undefined
        ? workspaceRelativeFilePath(activeProjectCwd, refName.worktreePath) !== null
        : workspaceRelativeFilePath(input.activeProjectCheckoutRoot, refName.worktreePath) === ".";
    const nextWorktreePath = isProjectCheckout ? null : refName.worktreePath;
    return {
      checkoutCwd: refName.worktreePath,
      nextWorktreePath,
      reuseExistingWorktree: true,
      // Listed refs can predate a checkout made outside the picker, so only Git can confirm this one.
      staysInActiveCheckout: nextWorktreePath === activeWorktreePath,
    };
  }

  const nextWorktreePath =
    activeWorktreePath !== null && refName.isDefault ? null : activeWorktreePath;

  return {
    checkoutCwd: nextWorktreePath ?? activeProjectCwd,
    nextWorktreePath,
    reuseExistingWorktree: false,
    staysInActiveCheckout: nextWorktreePath === activeWorktreePath,
  };
}

export function shouldReuseSelectedWorktree(
  selection: { readonly reuseExistingWorktree: boolean; readonly staysInActiveCheckout: boolean },
  canWriteSourceControl: boolean,
): boolean {
  return (
    selection.reuseExistingWorktree && !(selection.staysInActiveCheckout && canWriteSourceControl)
  );
}

export function isWorktreeChangeBlocked(input: {
  runtime: ThreadStructureRuntime | null;
  currentWorktreePath: string | null;
  nextWorktreePath: string | null;
}): boolean {
  return (
    input.nextWorktreePath !== input.currentWorktreePath &&
    deriveCanInterruptRunningThread(true, input.runtime)
  );
}

export function shouldIncludeBranchPickerItem(input: {
  itemValue: string;
  normalizedQuery: string;
  createBranchItemValue: string | null;
  checkoutPullRequestItemValue: string | null;
}): boolean {
  const { itemValue, normalizedQuery, createBranchItemValue, checkoutPullRequestItemValue } = input;

  if (normalizedQuery.length === 0) {
    return true;
  }

  if (createBranchItemValue && itemValue === createBranchItemValue) {
    return true;
  }

  if (checkoutPullRequestItemValue && itemValue === checkoutPullRequestItemValue) {
    return true;
  }

  const lowerItemValue = itemValue.toLowerCase();
  if (lowerItemValue.includes(normalizedQuery)) {
    return true;
  }

  const sanitizedQuery = sanitizeNewRefName(normalizedQuery);
  return (
    sanitizedQuery.length > 0 &&
    sanitizedQuery !== normalizedQuery &&
    lowerItemValue.includes(sanitizedQuery)
  );
}

export function resolveSshWorkspaceLabel(input: {
  workspaceLabel: string;
  sshSelected: boolean;
  savedLabel: string | null;
}): string {
  return input.sshSelected
    ? `SSH · ${input.savedLabel ?? "unavailable connection"}`
    : input.workspaceLabel;
}
