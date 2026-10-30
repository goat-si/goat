const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const replaceCallArguments = (
  line: string,
  args: Readonly<Record<string, unknown>>,
): string => {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value) || !isRecord(value.params)) throw new Error("Invalid tool call envelope.");
  return JSON.stringify({ ...value, params: { ...value.params, arguments: args } });
};

export const manifestApplied = (state: unknown, expectedSha256: string): boolean =>
  /^[a-f0-9]{64}$/u.test(expectedSha256) &&
  isRecord(state) &&
  isRecord(state.capability_manifest) &&
  state.capability_manifest.sha256 === expectedSha256 &&
  state.capability_manifest.file_sha256 === expectedSha256 &&
  state.capability_manifest.reload_error === null;

export const supportsBrowserClaims = (result: unknown): boolean => {
  if (!isRecord(result) || !Array.isArray(result.tools)) return false;
  const tool = result.tools.find(
    (entry: unknown) => isRecord(entry) && entry.name === "get_browser_state",
  );
  if (!isRecord(tool) || !isRecord(tool.inputSchema) || !isRecord(tool.inputSchema.properties))
    return false;
  return Object.hasOwn(tool.inputSchema.properties, "origin_scope");
};

export interface ProxyBrowserClaim {
  readonly claimId: string;
  readonly claimGeneration: number;
  readonly pid: number;
  readonly windowId: number;
  readonly tabId: string;
  readonly origins: ReadonlyArray<string>;
}

export const browserReplyOutsideClaim = (result: unknown, claim: ProxyBrowserClaim): boolean => {
  const inspect = (value: unknown, depth: number): boolean => {
    if (depth > 12 || !isRecord(value)) return false;
    if (value.code === "browser_origin_outside_scope") return true;
    if (value.tab_id === claim.tabId && typeof value.url === "string") {
      try {
        if (!claim.origins.includes(new URL(value.url).origin)) return true;
      } catch {
        return true;
      }
    }
    return Object.values(value).some((entry) =>
      Array.isArray(entry)
        ? entry.some((item) => inspect(item, depth + 1))
        : inspect(entry, depth + 1),
    );
  };
  return inspect(result, 0);
};

const scopedBrowserTools = new Set([
  "get_browser_state",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_pointer",
  "browser_select",
  "browser_dialog",
]);
const isBrowserTool = (name: unknown) =>
  typeof name === "string" &&
  (name.startsWith("browser_") || name === "get_browser_state" || name === "page");

export const scopeBrowserCall = (
  name: unknown,
  args: unknown,
  claims: ReadonlyArray<ProxyBrowserClaim>,
) => {
  if (
    name === "run_steps" &&
    isRecord(args) &&
    Array.isArray(args.steps) &&
    args.steps.some((step: unknown) => isRecord(step) && isBrowserTool(step.tool))
  )
    return { refused: true as const };
  if (!isBrowserTool(name)) return { unchanged: true as const };
  if (
    typeof name !== "string" ||
    !scopedBrowserTools.has(name) ||
    !isRecord(args) ||
    typeof args.tab_id !== "string"
  )
    return { refused: true as const };
  const claim = claims.find((candidate) => candidate.tabId === args.tab_id);
  if (
    claim === undefined ||
    claim.origins.length === 0 ||
    (args.pid !== undefined && args.pid !== claim.pid) ||
    (args.window_id !== undefined && args.window_id !== claim.windowId)
  )
    return { refused: true as const };
  return {
    args: { ...args, origin_scope: claim.origins },
    claimId: claim.claimId,
    claimGeneration: claim.claimGeneration,
  };
};

const desktopTools = new Set([
  "click",
  "double_click",
  "right_click",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "hotkey",
  "set_value",
  "select_text",
  "get_window_state",
  "get_accessibility_tree",
  "verify_state",
  "zoom",
  "move_cursor",
  "bring_to_front",
  "set_window_frame",
  "invoke_menu",
  "kill_app",
]);

export const refusesClaimedBrowserDesktopCall = (
  name: unknown,
  args: unknown,
  claimedPids: ReadonlyArray<number>,
): boolean => {
  if (claimedPids.length === 0 || typeof name !== "string") return false;
  const containsPid = (value: unknown, depth: number): boolean => {
    if (depth > 8) return true;
    if (Array.isArray(value)) return value.some((entry) => containsPid(entry, depth + 1));
    if (!isRecord(value)) return false;
    return (
      (typeof value.pid === "number" && claimedPids.includes(value.pid)) ||
      Object.values(value).some((entry) => containsPid(entry, depth + 1))
    );
  };
  return (desktopTools.has(name) || name === "run_steps") && containsPid(args, 0);
};
