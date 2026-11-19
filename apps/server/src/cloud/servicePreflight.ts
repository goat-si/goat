import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import packageJson from "../../package.json" with { type: "json" };
import {
  migrationLedgerProblem,
  readMigrationSnapshot,
  resolveMigrationSnapshotPath,
} from "../persistence/migrationPreflight.ts";
import type * as ProcessRunner from "../processRunner.ts";
import {
  pinnedRuntimeCommand,
  PinnedRuntimeInstallError,
  type PinnedRuntimePaths,
  PinnedRuntimePreflightBlockedError,
} from "./pinnedRuntime.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

// A staged runtime cold start can take over a minute on a loaded host.
const PREFLIGHT_TIMEOUT = Duration.minutes(3);
const decodePreflightJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export type ServicePreflightResult =
  | {
      readonly status: "ready";
      readonly version: string;
      readonly launcherProtocol: typeof SERVICE_LAUNCHER_PROTOCOL;
      readonly databaseChecked?: true;
    }
  | {
      readonly status: "blocked";
      readonly version: string;
      readonly reason: string;
    };

const unreadableDatabaseReason = (version: string) =>
  `Could not read this database to confirm goat@${version} supports it.`;

export function runServicePreflight(input: {
  readonly databasePath: string;
  readonly launcherProtocol: number;
  readonly version?: string;
}): ServicePreflightResult {
  const version = input.version ?? packageJson.version;
  if (input.launcherProtocol !== SERVICE_LAUNCHER_PROTOCOL) {
    return {
      status: "blocked",
      version,
      // A stale `goat` earlier on PATH (an old npm/nvm global) makes `goat service install`
      // reinstall itself and report success, so name the exact install and the path check.
      reason: [
        `The installed service launcher speaks protocol ${input.launcherProtocol}, but goat@${version} requires protocol ${SERVICE_LAUNCHER_PROTOCOL}.`,
        `On the server machine, install this exact CLI: \`curl -fsSL https://raw.githubusercontent.com/goat-si/goat-releases/main/install.sh | GOAT_VERSION=${version} sh\`.`,
        `Check that \`goat --version\` prints ${version} and that \`which -a goat\` lists no older goat (such as an npm or nvm install) first, then run \`~/.local/bin/goat service install\` (the installer's default path).`,
        "Updating the desktop app does not update this CLI, and `goat service update` only repairs the service with whichever CLI runs it.",
      ].join(" "),
    };
  }

  const snapshot = readMigrationSnapshot(input.databasePath);
  if (snapshot === null) {
    return {
      status: "blocked",
      version,
      reason: unreadableDatabaseReason(version),
    };
  }
  const problem = migrationLedgerProblem(snapshot, version);
  if (problem !== undefined) return { status: "blocked", version, reason: problem };

  return {
    status: "ready",
    version,
    launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
    databaseChecked: true,
  };
}

export function decodeServicePreflightResult(value: unknown): ServicePreflightResult | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.status === "ready" &&
    record.launcherProtocol === SERVICE_LAUNCHER_PROTOCOL &&
    typeof record.version === "string"
  ) {
    return {
      status: "ready",
      version: record.version,
      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
      ...(record.databaseChecked === true ? { databaseChecked: true } : {}),
    };
  }
  if (
    record.status === "blocked" &&
    typeof record.version === "string" &&
    typeof record.reason === "string"
  ) {
    return { status: "blocked", version: record.version, reason: record.reason };
  }
  return undefined;
}

export const runStagedServicePreflight = Effect.fn("cloud.service_preflight.run_staged")(
  function* (input: {
    readonly runner: ProcessRunner.ProcessRunner["Service"];
    readonly runtime: PinnedRuntimePaths;
    readonly targetVersion: string;
    readonly databasePath: string;
    readonly requireDatabaseCheck?: boolean;
  }) {
    const selectedPath = resolveMigrationSnapshotPath(input.databasePath);
    if (selectedPath === null) {
      return yield* new PinnedRuntimePreflightBlockedError({
        version: input.targetVersion,
        reason: unreadableDatabaseReason(input.targetVersion),
      });
    }
    const step = "running the staged service preflight";
    const command = pinnedRuntimeCommand(input.runtime);
    const result = yield* input.runner
      .run({
        command: command.command,
        args: [
          ...command.args,
          "__service-preflight",
          "--database-path",
          selectedPath ?? input.databasePath,
          "--launcher-protocol",
          String(SERVICE_LAUNCHER_PROTOCOL),
        ],
        timeout: PREFLIGHT_TIMEOUT,
      })
      .pipe(Effect.mapError((cause) => new PinnedRuntimeInstallError({ step, cause })));
    if (result.code !== 0) {
      return yield* new PinnedRuntimeInstallError({
        step,
        ...(result.code === null ? {} : { exitCode: Number(result.code) }),
        stdoutLength: result.stdout.length,
        stderrLength: result.stderr.length,
      });
    }
    const parsed = yield* decodePreflightJson(result.stdout.trim()).pipe(
      Effect.mapError(
        (cause) =>
          new PinnedRuntimeInstallError({ step: "decoding the staged service preflight", cause }),
      ),
    );
    const preflight = decodeServicePreflightResult(parsed);
    if (preflight === undefined || preflight.version !== input.targetVersion) {
      return yield* new PinnedRuntimeInstallError({
        step: "verifying the staged service preflight",
      });
    }
    if (preflight.status === "blocked") {
      return yield* new PinnedRuntimePreflightBlockedError({
        version: input.targetVersion,
        reason: preflight.reason,
      });
    }
    if (input.requireDatabaseCheck && preflight.databaseChecked !== true) {
      // Legacy runtimes could report ready after checking only the launcher protocol.
      const snapshot = readMigrationSnapshot(input.databasePath);
      if (snapshot === null || snapshot.hasMemoryTables || snapshot.history.length > 0) {
        return yield* new PinnedRuntimePreflightBlockedError({
          version: input.targetVersion,
          reason: `goat@${input.targetVersion} could not confirm it supports this database, so GOAT did not switch to it.`,
        });
      }
    }
  },
);
