import { ProjectId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { sweep } from "./ProjectSettingsOverrideSweep.ts";

it.effect(
  "removes an orphaned project's entry even when it holds only a built-in skill switch",
  () =>
    Effect.gen(function* () {
      const live = ProjectId.make("project:live");
      const orphan = ProjectId.make("project:orphan");
      const settings = yield* ServerSettings.ServerSettingsService;
      const optOut = { builtInSkills: { "goat-discipline": { enabled: false } } };
      yield* settings.updateSettings({
        projectSettingsOverrides: { [live]: optOut, [orphan]: optOut },
      });

      yield* sweep;

      const after = yield* settings.getSettings;
      assert.deepStrictEqual(after.projectSettingsOverrides, { [live]: optOut });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest(),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () => Effect.succeed([{ id: ProjectId.make("project:live") }] as never),
          }),
        ),
      ),
    ),
);
