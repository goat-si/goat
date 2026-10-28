import { browserSiteNote } from "@goat/provider-core/server/builtinSkills/browserSkillFiles";
import { computerUseAppNote } from "@goat/provider-core/server/builtinSkills/computerUseSkillFiles";
import * as HostProcess from "@goat/shared/HostProcess";

/**
 * The short note a Target carries when the cell binds it: an app's notes by bundle id or name,
 * or a site's notes by host. The QuickJS child asks through `__note` while it builds the Target.
 */
export const screenTargetNote = (kind: string, key: string): string | undefined => {
  if (key.length === 0 || key.length > 8192) return undefined;
  // Computer use always drives the machine this server runs on.
  if (kind === "app") return computerUseAppNote(HostProcess.Platform.defaultValue(), key);
  if (kind !== "site") return undefined;
  // A tab passes its whole URL; URL parsing keeps an IPv6 host's brackets, as browserSiteNote expects.
  try {
    const { protocol, hostname } = new URL(key);
    return protocol === "http:" || protocol === "https:" ? browserSiteNote(hostname) : undefined;
  } catch {
    return undefined;
  }
};
