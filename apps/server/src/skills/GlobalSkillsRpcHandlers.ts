import {
  GLOBAL_SKILLS_WS_METHODS,
  GlobalSkillsRpcError,
  WsGlobalSkillsRpcGroup,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import type * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import type * as ServerSettings from "../serverSettings.ts";
import { makeGlobalSkills } from "./GlobalSkills.ts";

const group = WsGlobalSkillsRpcGroup.middleware(RpcInstrumentation);

export function makeGlobalSkillsRpcLayer(
  globalSkillsDir: string,
  settings: ServerSettings.ServerSettingsService["Service"],
  providers: ProviderRegistry.ProviderRegistry["Service"],
) {
  const scan = Effect.fn("GlobalSkills.rescan")(function* () {
    const current = yield* settings.getSettings;
    const skills = makeGlobalSkills({
      globalSkillsDir,
      disabled: Effect.succeed(current.disabledGlobalSkills),
    });
    if (providers.rescanGlobalSkills === undefined) {
      return yield* new GlobalSkillsRpcError({ message: "Global skill refresh is unavailable." });
    }
    yield* providers.rescanGlobalSkills;
    return { globalSkillsDir: skills.globalSkillsDir, skills: yield* skills.list() };
  });
  const remove = Effect.fn("GlobalSkills.removeAndRescan")(function* (name: string) {
    const skills = makeGlobalSkills({ globalSkillsDir, disabled: Effect.succeed([]) });
    yield* skills.remove(name);
    return yield* scan();
  });
  return group.toLayer(
    group.of({
      [GLOBAL_SKILLS_WS_METHODS.globalRemove]: ({ name }) =>
        remove(name).pipe(
          Effect.mapError(
            () => new GlobalSkillsRpcError({ message: "Could not remove global skill." }),
          ),
        ),
      [GLOBAL_SKILLS_WS_METHODS.globalRescan]: () =>
        scan().pipe(
          Effect.mapError(
            () => new GlobalSkillsRpcError({ message: "Could not rescan global skills." }),
          ),
        ),
    }),
  );
}
