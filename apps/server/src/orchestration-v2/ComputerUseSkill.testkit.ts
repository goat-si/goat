import { DEFAULT_SERVER_SETTINGS } from "@goat/contracts";
import {
  carriesComputerUseSkill,
  carriesScreenCodeSkill,
} from "@goat/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import type * as ProviderSessionManager from "./ProviderSessionManager.ts";

type Manager = ProviderSessionManager.ProviderSessionManagerV2["Service"];

// Only the settings the computer use decision reads at call time; the full test settings layer
// also brings memory policy, which re-prepares sessions and changes what a test counts.
const skillOff = Layer.mock(ServerSettings.ServerSettingsService)({
  getSettings: Effect.succeed({
    ...DEFAULT_SERVER_SETTINGS,
    disabledBuiltInSkills: ["computer-use"],
  }),
});

/** Opens a turn that carries an `@computer` chip while Settings has the skill switched off. */
export const askComputer = (
  manager: Manager,
  input: Omit<Parameters<Manager["open"]>[0], "turnCapabilities">,
) => manager.open({ ...input, turnCapabilities: ["computer-use"] }).pipe(Effect.provide(skillOff));

/**
 * Whether a turn carries GOAT's desktop guidance: the computer use skill, or, on a turn that lists
 * goat_screen_run and so hides the driver's own tools, the screen-code skill that replaces it.
 */
export const carriesSkill = (config: Parameters<typeof carriesComputerUseSkill>[0]) =>
  carriesComputerUseSkill(config) || carriesScreenCodeSkill(config);
