const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const manifestApplied = (state: unknown, expectedSha256: string): boolean =>
  /^[a-f0-9]{64}$/u.test(expectedSha256) &&
  isRecord(state) &&
  state.capability_manifest_file_sha256 === expectedSha256 &&
  (state.capability_manifest_reload_error === undefined ||
    state.capability_manifest_reload_error === null);

export const supportsBrowserClaims = (result: unknown): boolean => {
  if (!isRecord(result) || !Array.isArray(result.tools)) return false;
  const tool = result.tools.find(
    (entry: unknown) => isRecord(entry) && entry.name === "get_browser_state",
  );
  if (!isRecord(tool) || !isRecord(tool.inputSchema) || !isRecord(tool.inputSchema.properties))
    return false;
  return Object.hasOwn(tool.inputSchema.properties, "origin_scope");
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
