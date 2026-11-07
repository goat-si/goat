import { DEFAULT_SERVER_SETTINGS, ServerSettings, ServerSettingsPatch } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { applyServerSettingsPatch } from "./serverSettings.ts";

const decodeSettings = Schema.decodeSync(ServerSettings);
const decodePatch = Schema.decodeSync(ServerSettingsPatch);

it("defaults older settings and replaces the disabled global skills list through a patch", () => {
  expect(decodeSettings({}).disabledGlobalSkills).toEqual([]);
  const patch = decodePatch({ disabledGlobalSkills: ["goat:one"] });
  const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, patch);
  expect(next.disabledGlobalSkills).toEqual(["goat:one"]);
  expect(applyServerSettingsPatch(next, { disabledGlobalSkills: [] }).disabledGlobalSkills).toEqual(
    [],
  );
});
