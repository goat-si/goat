// @effect-diagnostics nodeBuiltinImport:off -- Usage discovery reads the configured provider home.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeFSP from "node:fs/promises";

import { expandHomePath } from "@goat/provider-core/server/pathExpansion";
import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@goat/provider-core/server/usage";
import * as HostProcess from "@goat/shared/HostProcess";
import type { PiSettings } from "../settings.ts";
import { PI_ARGUMENTS_WITH_VALUES, resolvePiLaunchArgs } from "./mcpInjection.ts";
import {
  OMO_PROFILE,
  PI_PROFILE,
  resolveOmoSessionsDir,
  resolveOmoAgentDir,
  type PiRuntimeProfile,
} from "./profile.ts";

const PiScanState = Schema.Struct({ sessionId: Schema.mutableKey(Schema.String) });
const Usage = Schema.Struct({
  input: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.Unknown),
  cacheRead: Schema.optional(Schema.Unknown),
  cacheWrite: Schema.optional(Schema.Unknown),
  reasoning: Schema.optional(Schema.Unknown),
  cost: Schema.optional(Schema.Struct({ total: Schema.Unknown })),
});
const Identity = { id: Schema.NonEmptyString, timestamp: Schema.String };
const Model = { provider: Schema.NonEmptyString, model: Schema.NonEmptyString };
const Entry = Schema.Union([
  Schema.Struct({ type: Schema.Literal("session"), id: Schema.NonEmptyString }),
  Schema.Struct({
    ...Identity,
    type: Schema.Literal("message"),
    message: Schema.Union([
      Schema.Struct({
        ...Model,
        role: Schema.Literal("assistant"),
        responseModel: Schema.optional(Schema.NonEmptyString),
        usage: Usage,
      }),
      Schema.Struct({ role: Schema.Literal("toolResult"), usage: Usage }),
    ]),
  }),
  Schema.Struct({ ...Identity, ...Model, type: Schema.Literal("usage"), usage: Usage }),
  Schema.Struct({
    ...Identity,
    type: Schema.Literals(["compaction", "branch_summary"]),
    usage: Usage,
  }),
]);
const decodeEntry = Schema.decodeUnknownOption(Entry);
const decodeSettingsJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

function parseRecord(
  parsed: unknown,
  state: typeof PiScanState.Type,
  provider: "pi" | "omo",
): readonly UsageRecord[] {
  const decoded = decodeEntry(parsed);
  if (Option.isNone(decoded)) return [];
  const entry = decoded.value;
  if (entry.type === "session") {
    state.sessionId = entry.id;
    return [];
  }
  const timestampMs = parseTimestampMs(entry.timestamp);
  if (timestampMs === null) return [];
  const source = entry.type === "message" ? entry.message : entry;
  const usage = source.usage;
  // Auxiliary tool/summary records lack model attribution; match Pi's breakdown.
  const rateModel =
    "model" in source
      ? "responseModel" in source
        ? (source.responseModel ?? source.model)
        : source.model
      : undefined;
  const model = "provider" in source ? `${source.provider}/${rateModel}` : "Tools/summaries";
  const outputTokens = tokenCount(usage.output);
  const totals = {
    // Pi's input/cache counters are already disjoint.
    uncachedInputTokens: tokenCount(usage.input),
    cachedInputTokens: tokenCount(usage.cacheRead),
    cacheCreationTokens: tokenCount(usage.cacheWrite),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(usage.reasoning)),
  };
  const cost = usage.cost?.total;
  // Omitted Pi rates default to zero; use shared estimates without positive transcript cost.
  const reportedCostUsd =
    typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null;
  if (totalTokens(totals) === 0 && reportedCostUsd === null) return [];
  return [
    {
      provider,
      timestampMs,
      model,
      ...(rateModel === undefined ? {} : { rateModel }),
      sessionId: state.sessionId,
      totals,
      reportedCostUsd,
      speed: "standard",
      // Forks preserve IDs/timestamps; short random IDs need timestamp/model to avoid cross-session collisions.
      dedupeKey: JSON.stringify([provider, entry.id, entry.timestamp, model]),
    },
  ];
}

const makeUsageFormat = (
  provider: "pi" | "omo",
): TranscriptUsageFormat<typeof PiScanState.Type> => ({
  selectFields: {
    type: true,
    id: true,
    timestamp: true,
    provider: true,
    model: true,
    usage: true,
    message: { role: true, provider: true, model: true, responseModel: true, usage: true },
  },
  usageMarkers: ['"usage"', '"session"'],
  parseLine: (line, state) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    return parseRecord(parsed, state, provider);
  },
  parseProjected: (parsed, state) => parseRecord(parsed, state, provider),
  state: { initial: () => ({ sessionId: "" }), schema: PiScanState },
});

export const piUsageFormat = makeUsageFormat("pi");
export const omoUsageFormat = makeUsageFormat("omo");

const makeUsageReader = (
  profile: PiRuntimeProfile,
): ProviderUsageReader<PiSettings, Path.Path> => ({
  kind: "transcripts",
  provider: profile.driver,
  format: profile.driver === "pi" ? piUsageFormat : omoUsageFormat,
  directories: Effect.fn("piUsageReader.directories")(function* ({ config, environment }) {
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const platform = yield* HostProcess.Platform;
    const launchHome = (platform === "win32" ? environment.USERPROFILE : environment.HOME) || home;
    const sessionDirArg = config === undefined ? undefined : piLaunchSessionDir(config.launchArgs);
    const launchDir =
      sessionDirArg === undefined ? undefined : expandHomePath(sessionDirArg, launchHome);
    const settingsSessionDir =
      profile.driver === "omo" && !environment.OMO_CODING_AGENT_SESSION_DIR
        ? yield* Effect.promise(async () => {
            try {
              const value = decodeSettingsJson(
                await NodeFSP.readFile(
                  path.join(resolveOmoAgentDir(environment, launchHome, path), "settings.json"),
                  "utf8",
                ),
              );
              return typeof value === "object" &&
                value !== null &&
                "sessionDir" in value &&
                typeof value.sessionDir === "string"
                ? value.sessionDir
                : undefined;
            } catch {
              return undefined;
            }
          })
        : undefined;
    // --session-dir moves only GOAT-launched sessions; terminal sessions stay in Pi's own directory.
    return [
      ...(launchDir !== undefined && path.isAbsolute(launchDir)
        ? [{ dir: path.resolve(launchDir) }]
        : []),
      {
        dir:
          profile.driver === "pi"
            ? resolvePiSessionsDir(environment, home, path)
            : resolveOmoSessionsDir(environment, launchHome, path, settingsSessionDir),
      },
    ];
  }),
});

export const piUsageReader = makeUsageReader(PI_PROFILE);
export const omoUsageReader = makeUsageReader(OMO_PROFILE);

function piLaunchSessionDir(launchArgs: string): string | undefined {
  const resolved = resolvePiLaunchArgs(launchArgs);
  if (!resolved.ok) return undefined;
  let sessionDir: string | undefined;
  for (let index = 0; index < resolved.args.length; index += 1) {
    const arg = resolved.args[index];
    if (arg === undefined || !PI_ARGUMENTS_WITH_VALUES.has(arg)) continue;
    index += 1;
    if (arg === "--session-dir") sessionDir = resolved.args[index] || undefined;
  }
  return sessionDir;
}

/** Where Pi stores session JSONL files for a provider environment, matching Pi's own lookup. */
export function resolvePiSessionsDir(
  environment: NodeJS.ProcessEnv,
  home: string,
  path: Path.Path,
): string {
  const sessionDir = environment.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (sessionDir) return path.resolve(expandHomePath(sessionDir, home));
  const agentDir = environment.PI_CODING_AGENT_DIR?.trim();
  return path.resolve(
    agentDir ? expandHomePath(agentDir, home) : path.join(home, ".pi", "agent"),
    "sessions",
  );
}
