import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@goat/shared/HostProcess";
import { TextGenerationError } from "@goat/contracts";
import {
  MemoryGenerationRunnerError,
  type MemoryOperationName,
} from "@goat/provider-core/server/memoryGenerationRunner";

const ManagedSettings = Schema.Record(Schema.String, Schema.Unknown);
const decodeManagedSettings = Schema.decodeUnknownEffect(Schema.fromJsonString(ManagedSettings));

/** Injection point for native reg query and WSL reg.exe interop. Query failures fail closed. */
export const ClaudeMemoryRegistryQuery = Context.Reference<
  (
    key: string,
    environment: NodeJS.ProcessEnv,
  ) => Effect.Effect<string, MemoryGenerationRunnerError, ChildProcessSpawner.ChildProcessSpawner>
>("ClaudeMemoryRegistryQuery", {
  defaultValue: () => (key, environment) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const collect = (stream: ChildProcessSpawner.ChildProcessHandle["stdout"]) =>
        stream.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (text, chunk) => text + chunk,
          ),
        );
      const query = Effect.fn(function* (candidate: string, valueOnly = false) {
        const child = yield* spawner.spawn(
          ChildProcess.make(
            "reg.exe",
            ["query", candidate, ...(valueOnly ? ["/v", "Settings"] : [])],
            {
              env: environment,
              stdin: "ignore",
            },
          ),
        );
        const [stdout, stderr, code] = yield* Effect.all(
          [collect(child.stdout), collect(child.stderr), child.exitCode],
          { concurrency: "unbounded" },
        );
        return { stdout, stderr, code };
      });
      const unavailable = new MemoryGenerationRunnerError({ code: "unavailable" });
      const result = yield* query(key, true);
      if (result.code === 0 && !result.stderr.trim()) return result.stdout;
      // reg query documents only 0 (success) and 1 (failure), not a not-found code.
      // Certify absence using a successful key/ancestor listing, never localized errors.
      // https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/reg-query
      if (result.code !== 1 || result.stdout.trim() || !result.stderr.trim())
        return yield* unavailable;
      const fullKey = key
        .replace(/^HKLM/i, "HKEY_LOCAL_MACHINE")
        .replace(/^HKCU/i, "HKEY_CURRENT_USER");
      let candidate = fullKey;
      let missingChild = "";
      while (true) {
        const listing = yield* query(candidate);
        if (listing.code === 0 && !listing.stderr.trim()) {
          const lines = listing.stdout.split(/\r?\n/).filter((line) => line.trim());
          const normalized = candidate.toLowerCase();
          const isKey = (line: string) => {
            const name = line.trim().toLowerCase();
            return (
              name === normalized ||
              (name.startsWith(`${normalized}\\`) &&
                !name.slice(normalized.length + 1).includes("\\"))
            );
          };
          if (
            !lines.some(isKey) ||
            lines.some((line) => !isKey(line) && !/^\s+.+?\s+REG_[A-Z0-9_]+(?:\s+.*)?$/i.test(line))
          )
            return yield* unavailable;
          if (
            missingChild
              ? lines.some((line) => line.trim().toLowerCase() === missingChild.toLowerCase())
              : lines.some((line) => /^\s+Settings\s+REG_/i.test(line))
          )
            return yield* unavailable;
          return `${fullKey}\n    Settings    REG_SZ    {}`;
        }
        if (listing.code !== 1 || listing.stdout.trim() || !listing.stderr.trim())
          return yield* unavailable;
        const separator = candidate.lastIndexOf("\\");
        if (separator === -1) return yield* unavailable;
        missingChild = candidate;
        candidate = candidate.slice(0, separator);
      }
    }).pipe(
      Effect.timeout("5 seconds"),
      Effect.scoped,
      Effect.mapError(() => new MemoryGenerationRunnerError({ code: "unavailable" })),
    ),
});

const hasUnsafeManagedSettings = (settings: typeof ManagedSettings.Type) =>
  [
    "hooks",
    "policyHelper",
    "enabledPlugins",
    "extraKnownMarketplaces",
    "forceLoginGatewayUrl",
    "env",
    "apiKeyHelper",
  ].some((key) => settings[key] !== undefined);
const hasAdminPolicy = (settings: typeof ManagedSettings.Type) =>
  Object.entries(settings).some(
    ([key, value]) =>
      key !== "wslInheritsWindowsSettings" && key !== "managedSourcesBehavior" && value !== null,
  );

/** --settings disableAllHooks cannot override managed hooks. Inspect every file/drop-in
 * before spawning, including registry policy on Windows and WSL.
 * https://code.claude.com/docs/en/managed-settings
 */
export const verifyClaudeMemoryHooks = Effect.fn("Claude.verifyMemoryHooks")(function* (
  operation: MemoryOperationName,
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;
  const failure = new TextGenerationError({
    operation,
    detail: "Claude managed hooks could not be certified disabled for memory generation.",
    cause: new MemoryGenerationRunnerError({ code: "unavailable" }),
  });
  return yield* Effect.gen(function* () {
    // Accept remote admin-authored hooks as residual risk, matching existing one-shot Claude generation.
    const system =
      platform === "darwin"
        ? "/Library/Application Support/ClaudeCode"
        : platform === "win32"
          ? "C:\\Program Files\\ClaudeCode"
          : "/etc/claude-code";
    const files = [path.join(system, "managed-settings.json")];
    const dropins = path.join(system, "managed-settings.d");
    if (yield* fs.exists(dropins)) {
      for (const name of yield* fs.readDirectory(dropins))
        if (!name.startsWith(".") && name.endsWith(".json")) files.push(path.join(dropins, name));
    }
    let adminPolicyPresent = false;
    for (const file of files) {
      if (!(yield* fs.exists(file))) continue;
      const settings = yield* decodeManagedSettings(yield* fs.readFileString(file));
      // Reject even disabled hooks: the requested certificate is absence, not a precedence guess.
      // Managed plugins or a policy helper can install hooks/settings beyond this file snapshot.
      if (hasUnsafeManagedSettings(settings)) return yield* failure;
      // WSL /etc policy is user-writable and does not make Windows HKCU inapplicable.
      if (platform === "win32") adminPolicyPresent ||= hasAdminPolicy(settings);
    }
    if (platform === "darwin") {
      const managed = "/Library/Managed Preferences";
      const policies = [
        path.join(managed, "com.anthropic.claudecode.plist"),
        "/Library/Preferences/com.anthropic.claudecode.plist",
        path.join(home, "Library", "Preferences", "com.anthropic.claudecode.plist"),
      ];
      if (yield* fs.exists(managed))
        for (const name of yield* fs.readDirectory(managed))
          policies.push(path.join(managed, name, "com.anthropic.claudecode.plist"));
      for (const file of policies) if (yield* fs.exists(file)) return yield* failure;
    }
    if (platform === "win32" || environment.WSL_DISTRO_NAME) {
      const query = yield* ClaudeMemoryRegistryQuery;
      for (const hive of ["HKLM", "HKCU"]) {
        // HKCU is only a fallback below an admin document. Inspect HKLM regardless of files.
        if (hive === "HKCU" && adminPolicyPresent) continue;
        const key = `${hive}\\SOFTWARE\\Policies\\ClaudeCode`;
        const raw = yield* query(key, environment);
        const fullHive = hive === "HKLM" ? "HKEY_LOCAL_MACHINE" : "HKEY_CURRENT_USER";
        const header = `${fullHive}\\SOFTWARE\\Policies\\ClaudeCode`;
        const lines = raw.trim().split(/\r?\n/);
        if (lines.shift()?.trim().toLowerCase() !== header.toLowerCase()) return yield* failure;
        const value = lines
          .join("\n")
          .trim()
          .match(/^Settings\s+REG_(?:SZ|EXPAND_SZ)\s+([\s\S]+)$/i)?.[1];
        if (value === undefined) return yield* failure;
        const settings = yield* decodeManagedSettings(value);
        if (hasUnsafeManagedSettings(settings)) return yield* failure;
        adminPolicyPresent ||= hasAdminPolicy(settings);
      }
    }
    if (environment.WSL_DISTRO_NAME) {
      // Windows files still need native inspection; do not guess registry/file precedence.
      for (const file of [
        "/mnt/c/Program Files/ClaudeCode/managed-settings.json",
        "/mnt/c/Program Files/ClaudeCode/managed-settings.d",
      ])
        if (yield* fs.exists(file)) return yield* failure;
    }
  }).pipe(Effect.mapError(() => failure));
});
