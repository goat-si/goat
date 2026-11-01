import { resolveEnvironmentLoopbackUrl } from "@goat/client-runtime/connection";
import type { EnvironmentId } from "@goat/contracts";
import * as Option from "effect/Option";

import * as Dialog from "../components/ui/Dialog";
import { appAtomRegistry } from "../state/atom-registry";
import { environmentSession } from "../state/session";
import { type ExternalUrlTarget, tryOpenExternalUrl } from "./openExternalUrl";

/** Opens a URL from an environment; its loopback servers live on that machine, never on this phone. */
export async function tryOpenEnvironmentUrl(
  environmentId: EnvironmentId,
  url: string,
  target: ExternalUrlTarget,
): Promise<boolean> {
  const connection = Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
  const resolved = resolveEnvironmentLoopbackUrl({ url, connection, isDesktopRenderer: false });
  if (resolved._tag === "Unreachable") {
    Dialog.alert("Unable to open link", resolved.reason);
    return false;
  }
  return tryOpenExternalUrl(resolved.url, target);
}
