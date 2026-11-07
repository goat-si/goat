import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type * as ServerSettings from "../serverSettings.ts";
import type { ProviderWorkspaceSnapshot } from "@goat/provider-core/server/driver";
import { makeGlobalSkills } from "./GlobalSkills.ts";
import {
  BUILTIN_SKILL_PROVIDER_DRIVERS,
  isGoatSkillName,
  type ServerProvider,
  type ServerProviderSkill,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import type * as Scope from "effect/Scope";
import type { ProviderInstanceId } from "@goat/contracts";

export function mergeGlobalSkills(
  provider: ServerProvider,
  global: ReadonlyArray<ServerProviderSkill>,
): ServerProvider {
  const added = BUILTIN_SKILL_PROVIDER_DRIVERS.has(provider.driver) ? global : [];
  const merge = (skills: ReadonlyArray<ServerProviderSkill>) => [
    ...added,
    ...skills.filter((skill) => !isGoatSkillName(skill.name)),
  ];
  return {
    ...provider,
    skills: merge(provider.skills),
    ...(provider.workspaceSnapshots === undefined
      ? {}
      : {
          workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
            ...snapshot,
            skills: merge(snapshot.skills),
          })),
        }),
  };
}

export const refreshDependentAuth = Effect.fn("ProviderRegistry.refreshDependentAuth")(function* (
  previous: ServerProvider | undefined,
  provider: ServerProvider,
  providers: ReadonlyArray<ServerProvider>,
  refresh: (ids: ReadonlyArray<ProviderInstanceId>) => Effect.Effect<void>,
  scope: Scope.Scope,
) {
  const current = providers.find((candidate) => candidate.instanceId === provider.instanceId);
  if (previous && current && !Equal.equals(previous.auth, current.auth)) {
    yield* refresh(
      providers
        .filter((candidate) => candidate.authSourceInstanceId === provider.instanceId)
        .map((candidate) => candidate.instanceId),
    ).pipe(Effect.forkIn(scope));
  }
});

export function makeGlobalSkillInventory(
  root: string,
  settings: Option.Option<ServerSettings.ServerSettingsService["Service"]>,
) {
  const scan = Option.isNone(settings)
    ? Effect.logWarning("Global skills withheld: settings service unavailable.").pipe(
        Effect.as([] as ReadonlyArray<ServerProviderSkill>),
      )
    : settings.value.getSettings.pipe(
        Effect.flatMap((current) =>
          makeGlobalSkills({
            globalSkillsDir: root,
            disabled: Effect.succeed(current.disabledGlobalSkills),
          }).list(),
        ),
        Effect.tapError((cause) =>
          Effect.logWarning("Global skills scan failed; withholding skills", { cause }),
        ),
        Effect.orElseSucceed(() => [] as ReadonlyArray<ServerProviderSkill>),
      );
  const workspace = (provider: ServerProvider) => (snapshot: ProviderWorkspaceSnapshot) =>
    scan.pipe(
      Effect.map((globals) => ({
        ...snapshot,
        skills: mergeGlobalSkills({ ...provider, skills: snapshot.skills }, globals).skills,
      })),
    );
  const rescan = (
    update: (
      f: (providers: ReadonlyArray<ServerProvider>) => ReadonlyArray<ServerProvider>,
    ) => Effect.Effect<ReadonlyArray<ServerProvider>>,
  ) =>
    scan.pipe(
      Effect.flatMap((globals) =>
        update((providers) => providers.map((provider) => mergeGlobalSkills(provider, globals))),
      ),
    );
  const watch = (refresh: Effect.Effect<ReadonlyArray<ServerProvider>>) =>
    Option.isSome(settings)
      ? Effect.gen(function* () {
          const changes = yield* settings.value.subscribeChanges;
          yield* Stream.runForEach(changes, () => refresh).pipe(Effect.forkScoped);
        })
      : Effect.void;
  return { scan, workspace, rescan, watch };
}

export const makeRefreshAuthDependents =
  (refresh: (id: ProviderInstanceId) => Effect.Effect<ReadonlyArray<ServerProvider>>) =>
  (ids: ReadonlyArray<ProviderInstanceId>) =>
    Effect.forEach(
      ids,
      (id) =>
        refresh(id).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("cloud provider auth refresh failed", {
              instanceId: id,
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    );

export type RefreshDependentAuth = (ids: ReadonlyArray<ProviderInstanceId>) => Effect.Effect<void>;
