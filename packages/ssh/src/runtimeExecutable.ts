import type { DesktopSshEnvironmentTarget, EnvironmentId } from "@goat/contracts";
import { parseSemver } from "@goat/shared/semver";
import * as Effect from "effect/Effect";

import { runSshCommand } from "./command.ts";
import { SshLaunchError } from "./errors.ts";
import {
  isNodeScriptRunner,
  shellSingleQuote,
  type PreparedRemoteRuntime,
} from "./remoteRuntime.ts";
import { REMOTE_PROTOCOL_TOKEN_SCRIPT } from "./runtimeFactsScripts.ts";
import { inspectWindowsRuntime } from "./runtimeWindows.ts";
import type {
  SshAuthOperationInput,
  SshEnvironmentEffectContext,
  SshEnvironmentEffectError,
  SshTunnelEntry,
} from "./tunnel.ts";

const MARKER = "__goat_runtime_executable=";
const MAX_PATH = 4096;
const LOOKUP_TIMEOUT_MS = 30_000;

/**
 * Prints the selected version's installed GOAT when it is complete, unchanged since the probe and
 * reports that version; nothing otherwise. Never the requested version, PATH or another install.
 * Undefined without an installed single executable: a Node script runner, the GOAT app's server,
 * Windows (not supported here yet) or an unusable version.
 */
export const buildProvisionedRuntimeExecutableScript = (
  selected: PreparedRemoteRuntime,
): string | undefined => {
  const version = selected.version;
  if (
    version === null ||
    parseSemver(version) === null ||
    isNodeScriptRunner(selected.runner) ||
    selected.source === "app" ||
    selected.hostPlatform === "win32"
  )
    return undefined;
  return [
    REMOTE_PROTOCOL_TOKEN_SCRIPT,
    `selected_version=${shellSingleQuote(version)}`,
    'valid_version "$selected_version" || exit 0',
    'goat_cli="$HOME/.goat/runtime/goat/versions/$selected_version/goat"',
    '[ -x "$goat_cli" ] || exit 0',
    '[ "$(cat "${goat_cli%/goat}/.install-complete" 2>/dev/null)" = "$selected_version" ] || exit 0',
    `expected_digest=${shellSingleQuote(selected.installedExecutableSha256 ?? "")}`,
    'if [ -n "$expected_digest" ]; then',
    '  [ "$(runner_sha256 "$goat_cli")" = "$expected_digest" ] || exit 0',
    "fi",
    '[ "$("$goat_cli" --version </dev/null 2>/dev/null)" = "goat v$selected_version" ] || exit 0',
    `printf '${MARKER}%s\\n' "$goat_cli"`,
    "",
  ].join("\n");
};

/** Empty output means no usable executable; null is anything but one marker line. */
const parseExecutable = (stdout: string): string | undefined | null => {
  if (stdout === "") return undefined;
  const path =
    stdout.startsWith(MARKER) && stdout.endsWith("\n") ? stdout.slice(MARKER.length, -1) : "";
  return path.startsWith("/") && path.length <= MAX_PATH && !/[\0\r\n]/u.test(path) ? path : null;
};

export interface RuntimeExecutableShape {
  /**
   * The verified installed GOAT executable of the runtime this manager is attached to on the
   * target. Undefined without a usable attachment, for a pending replacement or an attachment
   * without an installed executable, and when the attachment changed during the lookup.
   */
  readonly provisionedRuntimeExecutable?: (
    target: DesktopSshEnvironmentTarget,
  ) => Effect.Effect<string | undefined, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
  /**
   * The environment a native Windows runtime this manager launched answers as, read from the
   * attachment without a round trip; undefined for any other attachment.
   */
  readonly nativeEnvironmentId?: (
    target: DesktopSshEnvironmentTarget,
  ) => Effect.Effect<
    EnvironmentId | undefined,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  >;
}

/** Remote scripts over the manager's SSH auth: arbitrary ones, and the executable lookup. */
export const makeRemoteScripts = (input: {
  readonly tunnels: ReadonlyMap<string, SshTunnelEntry>;
  readonly generations: ReadonlyMap<string, number>;
  readonly isClosed: () => boolean;
  readonly managedAliases: ReadonlySet<string>;
  readonly resolveManagedTarget: (
    target: DesktopSshEnvironmentTarget,
  ) => Effect.Effect<
    { readonly resolvedTarget: DesktopSshEnvironmentTarget; readonly key: string },
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  >;
  readonly validateManagedPin: (
    target: DesktopSshEnvironmentTarget,
  ) => Effect.Effect<unknown, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
  readonly runWithSshAuth: <T>(
    operation: SshAuthOperationInput<T>,
  ) => Effect.Effect<T, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
}) => {
  const runRemoteScript = Effect.fn("ssh/tunnel.runRemoteScript")(function* (
    target: DesktopSshEnvironmentTarget,
    script: { readonly script: string; readonly timeoutMs?: number },
  ): Effect.fn.Return<
    { readonly stdout: string; readonly stderr: string },
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  > {
    const { resolvedTarget, key } = yield* input.resolveManagedTarget(target);
    yield* input.validateManagedPin(resolvedTarget);
    return yield* input.runWithSshAuth({
      key,
      keyOnly: input.managedAliases.has(resolvedTarget.alias),
      target: resolvedTarget,
      operation: (authOptions) =>
        runSshCommand(resolvedTarget, {
          remoteCommandArgs: ["sh", "-s"],
          stdin: script.script,
          ...(script.timeoutMs === undefined ? {} : { timeoutMs: script.timeoutMs }),
          ...(authOptions.authSecret === undefined ? {} : { authSecret: authOptions.authSecret }),
          ...(authOptions.batchMode === undefined ? {} : { batchMode: authOptions.batchMode }),
          ...(authOptions.interactiveAuth === undefined
            ? {}
            : { interactiveAuth: authOptions.interactiveAuth }),
        }),
    });
  });

  const provisionedRuntimeExecutable = Effect.fn("ssh/tunnel.provisionedRuntimeExecutable")(
    function* (
      target: DesktopSshEnvironmentTarget,
    ): Effect.fn.Return<
      string | undefined,
      SshEnvironmentEffectError,
      SshEnvironmentEffectContext
    > {
      const { resolvedTarget, key } = yield* input.resolveManagedTarget(target);
      const entry = input.tunnels.get(key);
      if (entry === undefined) return undefined;
      const selected = entry.selectedRuntime;
      const generation = input.generations.get(key) ?? 0;
      // A disconnect, Forget or replacement during the round trip answers for another runtime.
      const current = () =>
        !input.isClosed() &&
        input.tunnels.get(key) === entry &&
        entry.selectedRuntime === selected &&
        entry.attachmentInvalidated !== true &&
        (input.generations.get(key) ?? 0) === generation;
      const native = selected.nativeWindows;
      if (native !== undefined) {
        if (!current()) return undefined;
        yield* input.validateManagedPin(resolvedTarget);
        // Re-read: the executable must still be the hashed one running as this instance.
        const state = yield* input.runWithSshAuth({
          key,
          keyOnly: input.managedAliases.has(resolvedTarget.alias),
          target: resolvedTarget,
          operation: (auth) => inspectWindowsRuntime(resolvedTarget, auth, selected.version ?? ""),
        });
        const live = state.live ? state.selection : null;
        return current() &&
          live !== null &&
          live.instanceId === native.instanceId &&
          live.sha256 === native.sha256
          ? live.executablePath
          : undefined;
      }
      const script = buildProvisionedRuntimeExecutableScript(selected);
      if (script === undefined || !current()) return undefined;
      const output = yield* runRemoteScript(target, { script, timeoutMs: LOOKUP_TIMEOUT_MS });
      const executable = parseExecutable(output.stdout);
      if (executable === null)
        return yield* new SshLaunchError({
          message: "The host answered the GOAT runtime lookup unexpectedly.",
          stdout: "",
        });
      return current() ? executable : undefined;
    },
  );

  const nativeId = Effect.fn("ssh/tunnel.nativeEnvironmentId")(function* (
    target: DesktopSshEnvironmentTarget,
  ): Effect.fn.Return<
    EnvironmentId | undefined,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  > {
    const { key } = yield* input.resolveManagedTarget(target);
    const entry = input.tunnels.get(key);
    return input.isClosed() || entry?.attachmentInvalidated === true
      ? undefined
      : entry?.selectedRuntime.nativeWindows?.environmentId;
  });

  return { runRemoteScript, provisionedRuntimeExecutable, nativeId };
};
