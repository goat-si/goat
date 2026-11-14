/** What the chat says under its header for each GOAT Bot availability. */
export function availabilityCopy(mainName: string, openName: string) {
  return {
    ready: "Answers here, works in its own threads",
    connecting: `Connecting to ${mainName}…`,
    home_offline: `${mainName}’s computer is offline.`,
    offline: `${mainName}'s computer is offline. Messages will be available when it reconnects.`,
    unsupported: "Update the server to use GOAT Bot here.",
    permission: "This connection does not have permission to message GOAT Bot.",
    legacy_active: "Your global agent is still working. Check again when it finishes.",
    error: `Couldn't reach ${openName}`,
  };
}
