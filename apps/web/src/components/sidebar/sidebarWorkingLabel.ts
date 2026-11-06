export function sidebarWorkingLabel(
  runtimeStatus: string | undefined,
  goalActive: boolean,
): string {
  if (goalActive) return "Goal";
  return runtimeStatus === "preparing" ? "Setting up" : "Working";
}
