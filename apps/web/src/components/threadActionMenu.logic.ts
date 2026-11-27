import { gtFallback, type useGT } from "gt-react";
import type { ContextMenuItem } from "@goat/contracts";
import type { SnoozePreset } from "@goat/client-runtime/state/thread-settled";

export type ThreadActionMenuId =
  | "bot-follow"
  | "bot-stop-following"
  | "continue-on-ssh"
  | "find"
  | "new-thread-on-branch"
  | "fork"
  | "fork:current"
  | "fork:worktree"
  | "promote"
  | "filter-by-project"
  | "turn-into-project"
  | "project-settings"
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "auto-settle"
  | "auto-settle:enabled"
  | "auto-settle:disabled"
  | "snooze"
  | `snooze:${string}`
  | "unsnooze"
  | "rename"
  | "regenerate-title"
  | "mark-unread"
  | "share-guest"
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "copy-thread"
  | "copy-thread-id"
  | "archive"
  | "delete";

export type DraftActionMenuId =
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "project-settings"
  | "discard";

export function buildDraftActionMenuItems(options: {
  readonly gt?: ReturnType<typeof useGT>;
  readonly hasPath: boolean;
  readonly hasBranch: boolean;
  readonly hasProject: boolean;
}): ReadonlyArray<ContextMenuItem<DraftActionMenuId>> {
  const gt = options.gt ?? gtFallback;
  return [
    {
      id: "copy",
      label: gt("Copy"),
      icon: "copy",
      disabled: !options.hasPath && !options.hasBranch,
      children: [
        ...(options.hasPath
          ? [{ id: "copy-path" as const, label: gt("Path"), icon: "folder" }]
          : []),
        ...(options.hasBranch
          ? [{ id: "copy-branch" as const, label: gt("Branch"), icon: "git-branch" }]
          : []),
      ],
    },
    ...(options.hasProject
      ? [{ id: "project-settings" as const, label: gt("Project settings"), icon: "settings" }]
      : []),
    {
      id: "discard",
      label: gt("Discard draft"),
      icon: "trash",
      destructive: true,
      separatorBefore: true,
    },
  ];
}

export interface ThreadActionMenuState {
  readonly gt?: ReturnType<typeof useGT>;
  readonly canOperate: boolean;
  /** The active chat owns the SSH host dialog. */
  readonly canOpenSshHandoff?: boolean | undefined;
  readonly canFollowWithBot?: boolean;
  readonly canFind?: boolean;
  readonly canRename?: boolean;
  readonly branch: string | null;
  readonly projectFilter: {
    readonly label: string;
    readonly isActive: boolean;
  } | null;
  readonly isPinned: boolean;
  readonly isSettled: boolean;
  readonly autoSettleEnabled: boolean;
  readonly isSnoozed: boolean;
  readonly canSnoozeNow: boolean;
  readonly isRegeneratingTitle: boolean;
  /** The thread is a delegated task the user may turn into a top-level thread. */
  readonly canPromote?: boolean | undefined;
  /** Archive rejects attached providers, so disable it while running. */
  readonly isRunning: boolean;
  readonly supports: {
    readonly settlement: boolean;
    readonly autoSettleOptOut: boolean;
    readonly snooze: boolean;
    readonly pinning: boolean;
    readonly titleRegeneration: boolean;
  };
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
  readonly snoozeLabels?: {
    readonly snooze: string;
    readonly wake: string;
    readonly custom: string;
  };
  /** Hide project actions and title edits for the global agent. */
  readonly globalAgent?: boolean | undefined;
  /** Guest links need their own grant, so the caller checks it instead of `canOperate`. */
  readonly canShareWithGuest?: boolean;
  /** A No project thread with its own folder, on a server that can promote it. */
  readonly canTurnIntoProject?: boolean;
  /** Absent or null hides forking, as for side chats. */
  readonly fork?: ThreadForkMenuState | null;
}

export interface ThreadForkMenuState {
  readonly canFork: boolean;
  readonly canForkIntoWorktree: boolean;
  /** Selects "Fork thread in same worktree". */
  readonly inWorktree: boolean;
  /** A hub-proxied server without fork support; the hub refuses a raw thread.fork. */
  readonly needsServerUpdate: boolean;
}

/** The fork entry alone, for menus that do not use buildThreadActionMenuItems. */
export function buildForkMenuItems(
  fork: ThreadForkMenuState | null | undefined,
  canOperate = true,
  gt: ReturnType<typeof useGT> = gtFallback,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  if (!fork) return [];
  const currentLabel = fork.inWorktree ? gt("Fork thread in same worktree") : gt("Fork thread");
  if (fork.canForkIntoWorktree) {
    return [
      {
        id: "fork",
        label: gt("Fork thread"),
        icon: "git-fork",
        disabled: !fork.canFork || !canOperate,
        children: [
          { id: "fork:current", label: currentLabel },
          { id: "fork:worktree", label: gt("Fork thread in new worktree") },
        ],
      },
    ];
  }
  return [
    {
      id: "fork:current",
      label: fork.needsServerUpdate
        ? gt("{action} (update this server)", { action: currentLabel })
        : currentLabel,
      icon: "git-fork",
      disabled: !fork.canFork || !canOperate,
    },
  ];
}

const GLOBAL_AGENT_HIDDEN_ACTIONS: ReadonlySet<ThreadActionMenuId> = new Set([
  "new-thread-on-branch",
  "fork",
  "fork:current",
  "fork:worktree",
  "filter-by-project",
  "project-settings",
  "rename",
  "regenerate-title",
]);

/** Local navigation, read markers, and copying remain available to read-only clients. */
export function threadActionRequiresOperate(action: ThreadActionMenuId): boolean {
  return ![
    "continue-on-ssh", // The dialog uses sshWorkspaceLaunch.permissionAtom.
    "find",
    "new-thread-on-branch",
    "project-settings",
    "mark-unread",
    "share-guest",
    "copy",
    "copy-path",
    "copy-branch",
    "copy-thread",
    "copy-thread-id",
  ].includes(action);
}

export function buildThreadActionMenuItems(
  state: ThreadActionMenuState,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  const gt = state.gt ?? gtFallback;
  const allItems: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> = [
    ...(state.canFollowWithBot && state.canOperate && !state.globalAgent
      ? [
          { id: "bot-follow" as const, label: gt("Ask a bot to follow…") },
          { id: "bot-stop-following" as const, label: gt("Stop following") },
        ]
      : []),
    ...(state.canPromote
      ? [
          {
            id: "promote" as const,
            label: gt("Promote to thread"),
            icon: "arrow-up-from-line",
          },
        ]
      : []),
    ...(state.canFind
      ? [{ id: "find" as const, label: gt("Find in thread"), icon: "text-search" }]
      : []),
    ...(state.branch
      ? [
          {
            id: "new-thread-on-branch" as const,
            label: gt("New thread on {branch}", { branch: state.branch }),
            icon: "message-square-plus",
          },
        ]
      : []),
    ...buildForkMenuItems(state.fork, true, gt),
    ...(state.canOpenSshHandoff
      ? [{ id: "continue-on-ssh" as const, label: gt("Continue on SSH host…"), icon: "terminal" }]
      : []),
    ...(state.supports.pinning
      ? [
          state.isPinned
            ? { id: "unpin" as const, label: gt("Unpin thread"), icon: "pin-off" }
            : { id: "pin" as const, label: gt("Pin thread"), icon: "pin" },
        ]
      : []),
    ...(state.supports.settlement
      ? [
          state.isSettled
            ? { id: "unsettle" as const, label: gt("Un-settle thread"), icon: "circle-check" }
            : { id: "settle" as const, label: gt("Settle thread"), icon: "circle-check" },
        ]
      : []),
    ...(state.supports.snooze
      ? [
          state.isSnoozed
            ? {
                id: "unsnooze" as const,
                label: state.snoozeLabels?.wake ?? "Wake thread",
                icon: "clock",
              }
            : {
                id: "snooze" as const,
                label: state.snoozeLabels?.snooze ?? "Snooze",
                icon: "clock",
                disabled: !state.canSnoozeNow,
                children: [
                  ...state.snoozePresets.map((preset) => ({
                    id: `snooze:${preset.id}` as const,
                    label: preset.label,
                    detail: preset.whenLabel,
                  })),
                  {
                    id: "snooze:custom" as const,
                    label: state.snoozeLabels?.custom ?? "Custom…",
                    separatorBefore: state.snoozePresets.length > 0,
                  },
                ],
              },
        ]
      : []),
    {
      id: "rename",
      label: gt("Rename thread"),
      icon: "pencil",
      disabled: state.canRename === false,
      separatorBefore: true,
    },
    ...(state.supports.titleRegeneration
      ? [
          {
            id: "regenerate-title" as const,
            label: state.isRegeneratingTitle ? gt("Regenerating…") : gt("Regenerate title"),
            icon: "refresh-cw",
            disabled: state.isRegeneratingTitle,
          },
        ]
      : []),
    { id: "mark-unread", label: gt("Mark unread"), icon: "mail-open" },
    ...(state.canShareWithGuest
      ? [{ id: "share-guest" as const, label: gt("Share with guest"), icon: "user-plus" }]
      : []),
    ...(state.projectFilter
      ? [
          {
            id: "filter-by-project" as const,
            label: state.projectFilter.isActive
              ? gt("Show all projects")
              : gt("Filter by {project}", { project: state.projectFilter.label }),
            icon: "folder-tree",
          },
        ]
      : []),
    ...(state.canTurnIntoProject
      ? [
          {
            id: "turn-into-project" as const,
            label: gt("Turn into project"),
            icon: "folder-plus",
            disabled: state.isRunning,
          },
        ]
      : []),
    ...(state.supports.autoSettleOptOut
      ? [
          {
            id: "auto-settle" as const,
            label: gt("Auto-settle behavior"),
            icon: "timer",
            children: [
              {
                id: "auto-settle:enabled" as const,
                label: gt("Follow settings"),
                checked: state.autoSettleEnabled,
              },
              {
                id: "auto-settle:disabled" as const,
                label: gt("Never"),
                checked: !state.autoSettleEnabled,
              },
            ],
          },
        ]
      : []),
    {
      id: "copy",
      label: gt("Copy"),
      icon: "copy",
      separatorBefore: true,
      children: [
        { id: "copy-path", label: gt("Path"), icon: "folder" },
        ...(state.branch
          ? [{ id: "copy-branch" as const, label: gt("Branch"), icon: "git-branch" }]
          : []),
        { id: "copy-thread", label: gt("Thread"), icon: "hash" },
        { id: "copy-thread-id", label: gt("Thread ID"), icon: "hash" },
      ],
    },
    { id: "project-settings", label: gt("Project settings"), icon: "settings" },
    {
      id: "archive",
      label: gt("Archive thread"),
      icon: "archive",
      disabled: state.isRunning,
      separatorBefore: true,
    },
    {
      id: "delete",
      label: gt("Delete"),
      destructive: true,
      icon: "trash",
    },
  ];
  const items = state.globalAgent
    ? allItems.filter((item) => !GLOBAL_AGENT_HIDDEN_ACTIONS.has(item.id))
    : allItems;
  return state.canOperate
    ? items
    : items.map((item) =>
        threadActionRequiresOperate(item.id)
          ? {
              ...item,
              disabled: true,
              ...(item.children
                ? { children: item.children.map((child) => ({ ...child, disabled: true })) }
                : {}),
            }
          : item,
      );
}
