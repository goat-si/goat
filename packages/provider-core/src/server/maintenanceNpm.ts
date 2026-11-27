import * as HostProcess from "@goat/shared/HostProcess";
import { resolveCommandPath } from "@goat/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { environmentCacheKey } from "./maintenanceEnvironmentCache.ts";
import { NPM_REGISTRY_PROBE_TIMEOUT, runProbe } from "./maintenanceProbe.ts";
import type { ProviderMaintenanceResolverServices } from "./maintenanceResolver.ts";

const nonEmptyString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const decodeOutdated = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Record(Schema.String, Schema.Struct({ latest: Schema.optional(Schema.String) })),
  ),
);
const decodeNpmList = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      dependencies: Schema.optional(
        Schema.Record(Schema.String, Schema.Struct({ version: Schema.optional(Schema.String) })),
      ),
    }),
  ),
);

export const npmProviderPackageNames = new Set<string>();
const NPM_IGNORED_VARIABLE = /^(?:CLAUDE|ELECTRON_RUN_AS_NODE$)/i;
type NpmGlobalLatestVersions = ReadonlyMap<string, string | null>;
const npmGlobalLatestVersionRuns = new Map<
  string,
  Deferred.Deferred<Option.Option<NpmGlobalLatestVersions>>
>();

// Unlike `npm view`, `outdated` applies min-release-age, before and their excludes.
const runNpmGlobalLatestVersions = Effect.fn("runNpmGlobalLatestVersions")(function* (
  npmPath: string,
  npmPrefix: string,
  env: NodeJS.ProcessEnv,
  packageName: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Only installed packages, so a missing one cannot force the `ls` fallback.
  const others = yield* Effect.filter(
    Array.from(npmProviderPackageNames).filter((name) => name !== packageName),
    (name) =>
      Effect.forEach([path.join(npmPrefix, "lib"), npmPrefix], (root) =>
        fileSystem
          .exists(path.join(root, "node_modules", ...name.split("/"), "package.json"))
          .pipe(Effect.orElseSucceed(() => false)),
      ).pipe(Effect.map((found) => found.includes(true))),
  );
  const packageNames = [packageName, ...others];
  const versions = new Map<string, string | null>(packageNames.map((name) => [name, null]));
  const outdated = yield* runProbe(
    npmPath,
    ["outdated", "-g", "--prefix", npmPrefix, "--json", ...packageNames],
    env,
    // npm outdated exits 1 when updates are available.
    [0, 1],
    NPM_REGISTRY_PROBE_TIMEOUT,
  );
  const outdatedEntries = outdated ? Option.getOrUndefined(decodeOutdated(outdated)) : undefined;
  // npm prints failures such as an unreachable registry as `{"error": ...}`, also exiting 1.
  if (!outdatedEntries || "error" in outdatedEntries) return versions;
  for (const name of packageNames) {
    versions.set(name, nonEmptyString(outdatedEntries[name]?.latest));
  }
  // An empty result means the installed version is still the eligible release.
  const current = packageNames.filter((name) => versions.get(name) === null);
  if (current.length === 0) return versions;
  const listed = yield* runProbe(
    npmPath,
    ["ls", "-g", "--prefix", npmPrefix, "--depth", "0", "--json", ...current],
    env,
    // npm ls still prints the tree but exits 1 when other globals have problems.
    [0, 1],
  );
  const listedEntries = listed ? Option.getOrUndefined(decodeNpmList(listed)) : undefined;
  for (const name of current) {
    versions.set(name, nonEmptyString(listedEntries?.dependencies?.[name]?.version));
  }
  return versions;
});

export const resolveNpmGlobalLatestVersion = Effect.fn("resolveNpmGlobalLatestVersion")(function* (
  packageName: string,
  npmPrefix: string,
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<string | null, never, ProviderMaintenanceResolverServices> {
  // Match the updater's npm and environment.
  const npmPath = yield* resolveCommandPath("npm", {
    env: { ...(yield* HostProcess.Environment), ...env },
  });
  if (!npmPath) return null;
  // Claude's driver sets its own variables and drops ELECTRON_RUN_AS_NODE; npm reads neither.
  const npmEnv = Object.entries(env).filter(([name]) => !NPM_IGNORED_VARIABLE.test(name));
  const key = [npmPath, npmPrefix, environmentCacheKey(Object.fromEntries(npmEnv))].join("\0");
  const versions = yield* Effect.acquireUseRelease(
    Effect.sync(() => {
      const running = npmGlobalLatestVersionRuns.get(key);
      if (running) return { running };
      const own = Deferred.makeUnsafe<Option.Option<NpmGlobalLatestVersions>>();
      npmGlobalLatestVersionRuns.set(key, own);
      return { own };
    }),
    (claim) =>
      claim.own
        ? runNpmGlobalLatestVersions(npmPath, npmPrefix, env, packageName).pipe(Effect.asSome)
        : Deferred.await(claim.running),
    (claim, exit) =>
      claim.own
        ? Effect.sync(() => {
            if (npmGlobalLatestVersionRuns.get(key) === claim.own) {
              npmGlobalLatestVersionRuns.delete(key);
            }
          }).pipe(
            Effect.andThen(
              Deferred.succeed(claim.own, Exit.isSuccess(exit) ? exit.value : Option.none()),
            ),
          )
        : Effect.void,
  );
  // A run interrupted before answering, or one started before this package was known, retries.
  if (Option.isSome(versions) && versions.value.has(packageName)) {
    return versions.value.get(packageName) ?? null;
  }
  return yield* resolveNpmGlobalLatestVersion(packageName, npmPrefix, env);
});
