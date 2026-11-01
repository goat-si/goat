/** The target a bind_app reply (a ref) or a tab reply ({targetRef}) hands back. */
export const replyTargetId = (value: unknown): string | undefined => {
  const reply = typeof value === "object" && value !== null ? value : undefined;
  const ref = reply && "targetRef" in reply ? reply.targetRef : reply;
  return typeof ref === "object" &&
    ref !== null &&
    "id" in ref &&
    typeof ref.id === "string" &&
    "kind" in ref &&
    (ref.kind === "app" || ref.kind === "tab")
    ? ref.id
    : undefined;
};
