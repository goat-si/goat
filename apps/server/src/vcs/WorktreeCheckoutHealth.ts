import { type ServerWorktreeCheckoutHealth, type ServerWorktreeScanStatus } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import { normalizeProjectPathForComparison } from "@goat/shared/path";
import { decodeJsonResult } from "@goat/shared/schemaJson";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveAvailableWorktreesDirectory } from "../worktreesDirectory.ts";

export class WorktreeCheckoutHealth extends Context.Service<
  WorktreeCheckoutHealth,
  {
    /** Null off Windows and until the first probe finishes; never waits for PowerShell. */
    readonly current: Effect.Effect<ServerWorktreeCheckoutHealth | null>;
    /** Each probe result that differs from the last one, for clients already connected. */
    readonly subscribeChanges: Effect.Effect<
      Stream.Stream<ServerWorktreeCheckoutHealth>,
      never,
      Scope.Scope
    >;
  }
>()("goat/vcs/WorktreeCheckoutHealth") {}

const DefenderProbe = Schema.Struct({
  realTimeProtection: Schema.NullOr(Schema.Boolean),
  runningMode: Schema.NullOr(Schema.String),
  /** Joined with "|", which no Windows path contains; PowerShell 5.1 writes an empty array as {}. */
  exclusions: Schema.NullOr(Schema.String),
  fileSystem: Schema.NullOr(Schema.String),
});
export type DefenderProbe = typeof DefenderProbe.Type;
const decodeDefenderProbe = decodeJsonResult(DefenderProbe);

export function parseDefenderProbe(stdout: string): DefenderProbe | null {
  const decoded = decodeDefenderProbe(stdout.trim());
  return Result.isSuccess(decoded) ? decoded.success : null;
}

function isWithin(directory: string, exclusion: string): boolean {
  const child = normalizeProjectPathForComparison(directory).replace(/\\+$/u, "");
  const parent = normalizeProjectPathForComparison(exclusion).replace(/\\+$/u, "");
  return parent.length > 0 && (child === parent || child.startsWith(`${parent}\\`));
}

/**
 * Reads a Defender probe the way Microsoft documents it: real-time protection from
 * Get-MpComputerStatus, folder exclusions from Get-MpPreference (which reports "N/A: Must
 * be an administrator to view exclusions" to everyone else), and the volume's file system,
 * since a Dev Drive is ReFS.
 */
export function assessWorktreeScanStatus(
  probe: DefenderProbe | null,
  directory: string,
): ServerWorktreeScanStatus {
  if (probe === null || probe.realTimeProtection === null) return "unknown";
  // Passive or EDR block mode means another antivirus does the real-time scanning.
  if (probe.runningMode !== null && probe.runningMode.toLowerCase() !== "normal") return "off";
  if (!probe.realTimeProtection) return "off";
  const exclusions =
    probe.exclusions === null ? null : probe.exclusions.split("|").filter((entry) => entry !== "");
  const readable = exclusions !== null && !exclusions.some((entry) => entry.startsWith("N/A"));
  if (readable && exclusions.some((entry) => isWithin(directory, entry))) return "excluded";
  // A Dev Drive is ReFS, and Defender scans a trusted one after the write. Whether this
  // volume is a trusted Dev Drive is only readable as localized fsutil output, so a ReFS
  // volume is not flagged rather than warned about on a guess.
  if (probe.fileSystem?.toLowerCase() === "refs") return "unknown";
  return readable ? "scanning" : "unverified";
}

// The folder travels in the environment, so no path is ever quoted into the script.
const PROBE_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$status = Get-MpComputerStatus",
  "$preference = Get-MpPreference",
  "$root = [System.IO.Path]::GetPathRoot($env:GOAT_WORKTREES_DIRECTORY)",
  "$volume = $null",
  "if ($root -match '^[A-Za-z]:') { $volume = Get-Volume -DriveLetter $root.Substring(0, 1) }",
  "[pscustomobject]@{",
  "  realTimeProtection = if ($status) { [bool]$status.RealTimeProtectionEnabled } else { $null }",
  "  runningMode = if ($status) { [string]$status.AMRunningMode } else { $null }",
  "  exclusions = if ($preference) { @($preference.ExclusionPath | Where-Object { $_ }) -join '|' } else { $null }",
  "  fileSystem = if ($volume) { [string]$volume.FileSystemType } else { $null }",
  "} | ConvertTo-Json -Compress",
].join("\n");

const CACHE_TTL = Duration.minutes(10);

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  const changes = yield* PubSub.unbounded<ServerWorktreeCheckoutHealth>();
  const cache = yield* Ref.make<{
    readonly directory: string;
    readonly checkedAt: number;
    readonly health: ServerWorktreeCheckoutHealth;
  } | null>(null);
  const refreshing = yield* Ref.make(false);

  const probe = Effect.fn("WorktreeCheckoutHealth.probe")(function* (directory: string) {
    const result = yield* runner
      .run({
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", PROBE_SCRIPT],
        env: { GOAT_WORKTREES_DIRECTORY: directory },
        timeout: Duration.seconds(20),
      })
      .pipe(Effect.option);
    const parsed = result._tag === "Some" ? parseDefenderProbe(result.value.stdout) : null;
    const health = {
      worktreesDirectory: directory,
      defender: assessWorktreeScanStatus(parsed, directory),
    } satisfies ServerWorktreeCheckoutHealth;
    const previous = yield* Ref.getAndSet(cache, {
      directory,
      checkedAt: yield* Clock.currentTimeMillis,
      health,
    });
    if (
      previous === null ||
      previous.health.worktreesDirectory !== health.worktreesDirectory ||
      previous.health.defender !== health.defender
    ) {
      yield* PubSub.publish(changes, health);
    }
    if (health.defender === "scanning" || health.defender === "unverified") {
      yield* Effect.logInfo("Microsoft Defender may scan new worktrees", health);
    }
  });

  // Config snapshots gate a client's connection, so they read the cache and never wait for
  // PowerShell; a missing or stale entry starts one background probe.
  const current: Effect.Effect<ServerWorktreeCheckoutHealth | null> = Effect.gen(function* () {
    if (platform !== "win32") return null;
    const setting = yield* settings.getSettings.pipe(
      Effect.map((value) => value.worktreesDirectory),
      Effect.orElseSucceed(() => ""),
    );
    // The folder new worktrees actually land in, after ~ expansion and the fallback
    // createWorktree uses when the configured one is unavailable.
    const { directory } = yield* resolveAvailableWorktreesDirectory(
      { setting, defaultDir: config.worktreesDir },
      fileSystem,
      path,
    );
    const now = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(cache);
    const usable = cached !== null && cached.directory === directory ? cached : null;
    if (usable === null || now - usable.checkedAt >= Duration.toMillis(CACHE_TTL)) {
      const start = yield* Ref.modify(refreshing, (running) => [!running, true] as const);
      if (start) {
        yield* probe(directory).pipe(
          Effect.ensuring(Ref.set(refreshing, false)),
          // The folder may have changed while PowerShell ran; check the one in effect now.
          Effect.andThen(Effect.suspend(() => current)),
          Effect.forkIn(scope),
        );
      }
    }
    return usable?.health ?? null;
  });

  // Probe at startup so the first client to connect already gets an answer, and again when
  // the Worktree location setting moves new worktrees to another folder.
  yield* current;
  if (platform === "win32") {
    const settingsChanges = yield* settings.subscribeChanges;
    yield* settingsChanges.pipe(
      Stream.map((value) => value.worktreesDirectory),
      Stream.changes,
      Stream.runForEach(() => current),
      Effect.forkIn(scope),
    );
  }

  return WorktreeCheckoutHealth.of({
    current,
    subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
  });
});

export const layer = Layer.effect(WorktreeCheckoutHealth, make);
