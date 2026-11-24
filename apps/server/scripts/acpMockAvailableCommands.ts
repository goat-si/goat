// Comma-separated command names the mock advertises, so `/compact` support is testable.
export const advertisedCommandNames = (process.env.GOAT_ACP_AVAILABLE_COMMANDS ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name.length > 0);
export const loadedCommandNames = process.env.GOAT_ACP_LOADED_COMMANDS?.split(",").filter(Boolean);

export const copilotModeId = (name: string) =>
  `https://agentclientprotocol.com/protocol/session-modes#${name}`;
export const modeOptionCategory = process.env.GOAT_ACP_MODE_OPTION_CATEGORY ?? "mode";
