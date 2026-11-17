import type { EnvironmentPresentation } from "~/state/environmentProjection";
import type { EnvironmentId } from "@goat/contracts";

import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";

export type LocalFolderTarget =
  | {
      readonly kind: "ready";
      readonly environmentId: EnvironmentId;
      readonly platform: NonNullable<
        EnvironmentPresentation["serverConfig"]
      >["environment"]["platform"]["os"];
    }
  | { readonly kind: "local-off" }
  | { readonly kind: "starting" }
  | { readonly kind: "not-this-machine" }
  | { readonly kind: "browser" };

/**
 * Where a folder path from this computer can open as a project. Only a server on this computer
 * can read the path: the desktop's primary environment or a desktop-local one, as
 * browserTargetResolver decides for loopback. With the local environment off there is no such
 * server, which a person should be told rather than left waiting for.
 */
export function resolveLocalFolderTarget(input: {
  readonly isDesktopRenderer: boolean;
  readonly localEnvironmentDisabled: boolean;
  readonly primary:
    | (Pick<EnvironmentPresentation, "entry" | "connection" | "serverConfig"> & {
        readonly environmentId: EnvironmentId;
      })
    | null;
  readonly shellHasSnapshot: boolean;
}): LocalFolderTarget {
  if (!input.isDesktopRenderer) return { kind: "browser" };
  if (input.localEnvironmentDisabled) return { kind: "local-off" };
  const { primary } = input;
  if (
    primary === null ||
    primary.connection.phase !== "connected" ||
    primary.serverConfig === null ||
    !input.shellHasSnapshot
  ) {
    return { kind: "starting" };
  }
  const { target } = primary.entry;
  if (target._tag !== "PrimaryConnectionTarget" && !isDesktopLocalConnectionTarget(target)) {
    return { kind: "not-this-machine" };
  }
  return {
    kind: "ready",
    environmentId: primary.environmentId,
    platform: primary.serverConfig.environment.platform.os,
  };
}
