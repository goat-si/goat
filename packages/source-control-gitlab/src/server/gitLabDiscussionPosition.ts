export function gitLabDiscussionPosition(position: {
  readonly position_type?: string | null | undefined;
  readonly old_path?: string | null | undefined;
  readonly new_path?: string | null | undefined;
  readonly old_line?: number | null | undefined;
  readonly new_line?: number | null | undefined;
}) {
  let side: "left" | "right";
  let path: string | null | undefined;
  let line: number | null | undefined;
  if (position.position_type === "text") {
    side = position.new_line == null ? "left" : "right";
    path = side === "left" ? position.old_path : position.new_path;
    line = side === "left" ? position.old_line : position.new_line;
  } else if (position.position_type === "file" || position.position_type === "image") {
    side = "right";
    path = position.new_path?.trim() || position.old_path;
    line = null;
  } else {
    return null;
  }
  const cleanPath = path?.trim();
  return cleanPath
    ? { path: cleanPath, line: typeof line === "number" && line > 0 ? line : null, side }
    : null;
}
