import { resolveSettings, type Settings } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** Present only in the environment of a Claude Code instance routed through OpenCodex Home. */
export const CLAUDE_HOME_ROUTE_MARKER = "GOAT_CLAUDE_HOME_ROUTE";
/** Endpoint, credential and backend switches a routed Claude Code launch must not take elsewhere. */
const CLAUDE_HOME_PINNED_ENV = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

/**
 * Claude Code applies settings-file env over its process environment, and its flag tier
 * (--settings, the SDK settings option) over user, project and local files. A routed launch pins
 * the Home values there; only an administrator's managed tier ranks higher.
 */
export const claudeHomeFlagSettings = (
  environment: Readonly<Record<string, string | undefined>> | undefined,
): { readonly env?: Record<string, string> } =>
  environment?.[CLAUDE_HOME_ROUTE_MARKER] !== "1"
    ? {}
    : {
        env: Object.fromEntries(
          CLAUDE_HOME_PINNED_ENV.map((name) => [name, environment[name] ?? ""]),
        ),
      };

/** Adds the Home pins to SDK query options; a settings path cannot take keys, so it is replaced. */
export const pinClaudeHomeSettings = <
  O extends {
    readonly env?: Readonly<Record<string, string | undefined>> | undefined;
    readonly settings?: string | Settings | undefined;
  },
>(
  options: O,
): O => {
  const { env } = claudeHomeFlagSettings(options.env);
  if (env === undefined) return options;
  const settings = typeof options.settings === "object" ? options.settings : {};
  return Object.assign({}, options, {
    settings: { ...settings, env: { ...settings.env, ...env } },
  });
};

class ClaudeHomeOverriddenError extends Schema.TaggedError<ClaudeHomeOverriddenError>()(
  "ClaudeHomeOverriddenError",
  { detail: Schema.String },
) {}
const RemoteSettings = Schema.Struct({
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  policyHelper: Schema.optionalKey(Schema.Unknown),
});
const decodeRemoteSettings = Schema.decodeUnknownOption(Schema.fromJsonString(RemoteSettings));
const pinnedKeys = (env: Readonly<Record<string, unknown>> | undefined) =>
  Object.keys(env ?? {}).filter((name) => CLAUDE_HOME_PINNED_ENV.some((pinned) => pinned === name));

/**
 * Refuses a Home route that Claude Code would not honor: managed settings, including the cached
 * server-managed copy in this instance's Claude home, outrank the flag tier.
 * A managed policy helper computes more managed settings at Claude's startup; resolveSettings
 * does not run it, so its output cannot be checked and the route is refused.
 */
export const assertClaudeHomeEnforceable = Effect.fn("ClaudeHomeSettings.assertEnforceable")(
  function* (claudeHome: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const remote = yield* fs.readFileString(path.join(claudeHome, "remote-settings.json")).pipe(
      Effect.map((text) => Option.getOrUndefined(decodeRemoteSettings(text))),
      Effect.orElseSucceed(() => undefined),
    );
    const resolved = yield* Effect.tryPromise(() => resolveSettings({ settingSources: [] })).pipe(
      Effect.mapError(
        () =>
          new ClaudeHomeOverriddenError({
            detail:
              "Could not read Claude Code's managed settings, so Home routing cannot be verified.",
          }),
      ),
    );
    const helper =
      remote?.policyHelper !== undefined ||
      resolved.sources.some(
        ({ source, settings }) => source === "managed" && settings.policyHelper !== undefined,
      );
    if (helper)
      return yield* new ClaudeHomeOverriddenError({
        detail:
          "Claude Code managed settings on this machine run a policy helper at startup, which can override OpenCodex Home and cannot be checked beforehand. Keep this instance on its own route, or ask the administrator to remove the helper.",
      });
    const managed = [
      ...pinnedKeys(remote?.env),
      ...resolved.sources
        .filter(({ source }) => source === "managed")
        .flatMap(({ settings }) => pinnedKeys(settings.env)),
    ];
    if (managed.length > 0)
      return yield* new ClaudeHomeOverriddenError({
        detail: `Claude Code managed settings on this machine set ${[...new Set(managed)].join(", ")}, which overrides OpenCodex Home. Ask the administrator to remove them, or keep this instance on its own route.`,
      });
  },
);
