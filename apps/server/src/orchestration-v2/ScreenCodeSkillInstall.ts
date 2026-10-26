// @effect-diagnostics nodeBuiltinImport:off -- The guide is written at attachment time.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  SCREEN_CODE_SKILL_DIRECTORY,
  SCREEN_CODE_SKILL_FILE,
  screenCodeSkillFiles,
} from "@goat/provider-core/server/builtinSkills/screenCodeSkillFiles";
import type { BuiltInSkillName } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";

export function installScreenCodeSkillAt(stateDir: string): string | undefined {
  const directory = NodePath.join(stateDir, "skills", SCREEN_CODE_SKILL_DIRECTORY);
  try {
    for (const [relative, content] of Object.entries(screenCodeSkillFiles())) {
      const target = NodePath.join(directory, relative);
      let current: string | undefined;
      try {
        current = NodeFS.readFileSync(target, "utf8");
      } catch {
        current = undefined;
      }
      if (current === content) continue;
      NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
      const temporary = target + ".tmp-" + process.pid;
      NodeFS.writeFileSync(temporary, content);
      NodeFS.renameSync(temporary, target);
    }
    return NodePath.join(directory, SCREEN_CODE_SKILL_FILE);
  } catch {
    return undefined;
  }
}

export const installScreenCodeSkill = Effect.gen(function* () {
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  if (Option.isNone(config)) return undefined;
  const path = yield* Effect.sync(() => installScreenCodeSkillAt(config.value.stateDir));
  if (path === undefined) yield* Effect.logWarning("Built-in screen guide could not be installed.");
  return path;
});

export const installScreenCodeSkillWhenActive = (skills: ReadonlyArray<BuiltInSkillName>) =>
  skills.includes("screen-code") ? installScreenCodeSkill : Effect.succeed(undefined);

export const screenSkillPath = (path: string | undefined) =>
  path === undefined ? {} : { screenCodeSkillPath: path };
