import type { PullRequestReviewPosition } from "@goat/contracts";

export function diffCursorPage(cursor: string): number | null {
  return /^[1-9][0-9]{0,6}$/.test(cursor) ? Number(cursor) : null;
}

export function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(value);
}

export function projectPath(repository: string): string {
  return encodeURIComponent(repository.trim());
}

export function gitLabReviewPositionLines(
  position: PullRequestReviewPosition,
):
  | { readonly new_line: number }
  | { readonly old_line: number }
  | { readonly old_line: number; readonly new_line: number } {
  switch (position.kind) {
    case "added":
      return { new_line: position.newLine };
    case "deleted":
      return { old_line: position.oldLine };
    case "context":
      return { old_line: position.oldLine, new_line: position.newLine };
  }
}
