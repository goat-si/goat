import type { ServerConfig, ServerConfigStreamEvent } from "@goat/contracts";

export const snapshotConfig = (fields: Partial<ServerConfig>) =>
  ({ availableEditors: [], settings: {}, ...fields }) as unknown as ServerConfig;
export const settingsUpdated = (settings: object): ServerConfigStreamEvent => ({
  version: 1,
  type: "settingsUpdated",
  payload: { settings: settings as ServerConfig["settings"] },
});
