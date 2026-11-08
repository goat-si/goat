import * as NodeCrypto from "node:crypto";

import type { CodexSettings } from "@goat/contracts";

/** What a Codex app-server process starts with; custom models only change the model picker. */
export const codexSessionConfigKey = (
  settings: CodexSettings,
  environment: NodeJS.ProcessEnv,
): string =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        sortedEntries(settings).filter(([key]) => key !== "customModels"),
        sortedEntries(environment),
      ]),
    )
    .digest("hex");

const sortedEntries = (value: object) =>
  Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
