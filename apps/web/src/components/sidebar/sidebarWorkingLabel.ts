export function sidebarWorkingLabel(
  runtimeStatus: string | undefined,
  goalActive: boolean,
): string {
  if (runtimeStatus === "preparing") return "Setting up";
  return goalActive ? "Goal" : "Working";
}
