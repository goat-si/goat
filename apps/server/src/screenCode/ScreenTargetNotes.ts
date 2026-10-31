import { computerUseAppNote } from "@goat/provider-core/server/builtinSkills/computerUseSkillFiles";
import * as HostProcess from "@goat/shared/HostProcess";

/**
 * App notes by bundle id or name, requested by the QuickJS child while it builds a Target.
 */
export const screenTargetNote = (kind: string, key: string): string | undefined => {
  if (key.length === 0 || key.length > 8192) return undefined;
  // Computer use always drives the machine this server runs on.
  if (kind === "app") return computerUseAppNote(HostProcess.Platform.defaultValue(), key);
  return undefined;
};
