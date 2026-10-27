import type { ProviderInstanceId } from "@goat/contracts";
import type { McpProviderSessionConfig } from "@goat/provider-core/server/mcpSession";
import * as HostProcess from "@goat/shared/HostProcess";
import { resolveSelfInvocation, selfInvocationArgs } from "@goat/shared/nodeRuntime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type * as ServerSettings from "../serverSettings.ts";
import { URL_OPENER_COMMAND } from "./urlOpenerCli.ts";

const SHIM_NAME = "goat-browser";
// Readers split BROWSER on ":" (Python, xdg-open) and on whitespace (xdg-open), so the value
// must be one plain path.
const UNSAFE_BROWSER_VALUE = /[\s:;%"'\\]/;

const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

/**
 * Writes the executable GOAT sets as BROWSER for a thread's processes, in `directory`. None when
 * the server's own environment already names a BROWSER, which stays the user's choice, and none
 * on Windows, where a cmd shim would reparse the URL and few tools read BROWSER.
 */
export const ensureUrlOpenerShim = Effect.fn("UrlOpenerShim.ensure")(
  function* (directory: string) {
    if ((yield* HostProcess.Platform) === "win32") return undefined;
    if ((yield* HostProcess.Environment).BROWSER !== undefined) return undefined;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const shimPath = path.join(directory, SHIM_NAME);
    if (UNSAFE_BROWSER_VALUE.test(shimPath)) {
      yield* Effect.logWarning("GOAT's URL opener is off: its path cannot be a BROWSER value.", {
        shimPath,
      });
      return undefined;
    }
    const invocation = yield* resolveSelfInvocation();
    const command = [invocation.command, ...selfInvocationArgs(invocation, [URL_OPENER_COMMAND])]
      .map(shellQuote)
      .join(" ");
    yield* fs.writeFileString(
      shimPath,
      `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${command} "$@"\n`,
    );
    yield* fs.chmod(shimPath, 0o755);
    return shimPath;
  },
  Effect.catch((cause) =>
    Effect.logWarning("GOAT's URL opener is off: its shim was not written.", cause).pipe(
      Effect.as(undefined),
    ),
  ),
);

/**
 * Sets or clears a thread config's opener on every prepare: a BROWSER in the provider instance's
 * environment settings is the user's choice, and overlays cannot see it.
 */
export const instanceUrlOpener = Effect.fn("UrlOpenerShim.instanceUrlOpener")(function* (
  serverSettings: Option.Option<
    Pick<ServerSettings.ServerSettingsService["Service"], "getSettings">
  >,
  providerInstanceId: ProviderInstanceId,
  urlOpener: string | undefined,
) {
  const settings = Option.isSome(serverSettings)
    ? yield* serverSettings.value.getSettings.pipe(Effect.option)
    : Option.none();
  const chosen = Option.match(settings, {
    onNone: () => false,
    onSome: (value) =>
      value.providerInstances[providerInstanceId]?.environment?.some(
        (variable) => variable.name === "BROWSER",
      ) === true,
  });
  return (config: McpProviderSessionConfig): McpProviderSessionConfig => {
    const { urlOpener: _, ...rest } = config;
    return chosen || urlOpener === undefined ? rest : { ...rest, urlOpener };
  };
});
