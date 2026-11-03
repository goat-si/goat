import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";

export function folderName(path: string | null | undefined): string | null {
  if (!path?.trim()) return null;
  const segments = path.split(/[\\/]+/).filter(Boolean);
  const last = segments.at(-1);
  return last === undefined || (segments.length === 1 && /^[a-z]:$/i.test(last)) ? null : last;
}

export function threadListV2RowAccessibilityLabel(input: {
  readonly thread: Pick<EnvironmentThreadShell, "title" | "worktreePath" | "branch">;
  readonly hasQueuedMessages?: boolean;
  readonly isRegeneratingTitle: boolean;
}): string {
  const { thread } = input;
  const folder = folderName(thread.worktreePath);
  const worktreeLabel = thread.worktreePath?.trim()
    ? `, in ${folder ? `worktree ${folder}` : "a worktree"}${thread.branch ? ` (${thread.branch})` : ""}`
    : "";
  return `${thread.title}${input.hasQueuedMessages ? ", messages queued to send" : ""}${input.isRegeneratingTitle ? ", regenerating title" : ""}${worktreeLabel}`;
}
