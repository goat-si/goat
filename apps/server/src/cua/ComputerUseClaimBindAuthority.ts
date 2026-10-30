export interface PendingBrowserBind {
  readonly claimId: string;
  readonly pid: number;
  readonly windowId: number;
  readonly origin: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const authorizeClaimBind = (
  authority: string | undefined,
  tool: unknown,
  args: unknown,
  pending: ReadonlyArray<PendingBrowserBind>,
): PendingBrowserBind | undefined => {
  if (authority !== "claimBind" || !isRecord(args)) return undefined;
  const claim = pending.find(
    (entry) => entry.pid === args.pid && entry.windowId === args.window_id,
  );
  if (!claim) return undefined;
  if (tool === "get_browser_state") {
    if (
      Object.keys(args).some((key) => !["pid", "window_id", "mode", "origin_scope"].includes(key))
    )
      return undefined;
    return args.mode === "bind" &&
      Array.isArray(args.origin_scope) &&
      args.origin_scope.length === 1 &&
      args.origin_scope[0] === claim.origin
      ? claim
      : undefined;
  }
  if (tool === "browser_prepare") {
    if (
      Object.keys(args).some(
        (key) => !["pid", "window_id", "strategy", "delivery_mode"].includes(key),
      )
    )
      return undefined;
    return args.strategy === "existing_profile" &&
      (args.delivery_mode === undefined || args.delivery_mode === "background")
      ? claim
      : undefined;
  }
  return undefined;
};
