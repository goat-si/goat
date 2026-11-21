import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Duration from "effect/Duration";
import { DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL } from "@goat/contracts";
import { resolveServerBackgroundActivitySettings } from "@goat/shared/backgroundActivitySettings";
import { resolveProjectSettings } from "@goat/shared/projectSettings";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";

export class VcsAutomaticFetchInterval extends Context.Reference<Effect.Effect<Duration.Duration>>(
  "goat/vcs/VcsAutomaticFetchInterval",
  { defaultValue: () => Effect.succeed(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL) },
) {}

export const layerAutomaticFetchInterval = Layer.effect(
  VcsAutomaticFetchInterval,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    return serverSettings.getSettings.pipe(
      Effect.map(
        (settings) => resolveServerBackgroundActivitySettings(settings).automaticGitFetchInterval,
      ),
      Effect.orElseSucceed(() => DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL),
    );
  }),
);

export class VcsAutoPullPolicy extends Context.Reference<{
  readonly isEnabled: (cwd: string) => Effect.Effect<boolean, never>;
}>("goat/vcs/VcsAutoPullPolicy", {
  defaultValue: () => ({ isEnabled: () => Effect.succeed(false) }),
}) {}

export const layerAutoPullPolicy = Layer.effect(
  VcsAutoPullPolicy,
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    return {
      isEnabled: Effect.fn("VcsAutoPullPolicy.isEnabled")(
        function* (cwd: string) {
          const project = yield* projects.findActiveByWorkspaceRoot(cwd);
          if (project._tag === "None") return false;
          const settings = yield* serverSettings.getSettings;
          return resolveProjectSettings(settings, project.value.projectId).settings.defaultAutoPull;
        },
        Effect.orElseSucceed(() => false),
      ),
    };
  }),
);
