import type { ProviderInstanceEnvironment } from "@goat/contracts";
import { overlayEnvironment } from "@goat/shared/environmentOverlay";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";

import { expandHomePath } from "./pathExpansion.ts";

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const home = yield* HostProcess.HomeDirectory;
  const own: Record<string, string> = {};
  for (const variable of environment) {
    own[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value, home)
        : variable.value;
  }
  // A view, not a copy: an instance created before the login shell answered still sees its PATH.
  return overlayEnvironment(baseEnv, own);
});
