import type { EnvironmentId } from "@goat/contracts";

import {
  isEnvironmentUrlUnreachableError,
  openEnvironmentUrlExternally,
  urlNeedsEnvironmentRoute,
} from "~/browser/openEnvironmentUrl";
import { isElectron } from "~/env";
import { readLocalApi } from "~/localApi";
import { isLocalEditorFileHref } from "~/markdown-links";

import { stackedThreadToast, toastManager } from "../ui/toast";
import { reportMarkdownActionFailure } from "./markdownActionFailure";

// Thread links come from the environment, so its loopback servers open at the environment's address.
export function openMarkdownLinkExternally(
  environmentId: EnvironmentId | null,
  target: string,
): Promise<void> {
  if (environmentId !== null)
    return openEnvironmentUrlExternally(environmentId, absoluteLinkUrl(target));
  return readLocalApi()?.shell.openExternal(target) ?? Promise.resolve();
}

export function reportMarkdownExternalOpenFailure(target: string, cause: unknown): void {
  reportMarkdownActionFailure({ operation: "open-link-external", target }, cause);
  if (!isEnvironmentUrlUnreachableError(cause)) return;
  toastManager.add(
    stackedThreadToast({ type: "error", title: "Unable to open link", description: cause.message }),
  );
}

function markdownLinkNeedsEnvironmentRoute(
  environmentId: EnvironmentId | null,
  href: string,
): boolean {
  return urlNeedsEnvironmentRoute(environmentId, absoluteLinkUrl(href));
}

export function openMarkdownLinkInSystemBrowser(environmentId: EnvironmentId | null, href: string) {
  void openMarkdownLinkExternally(environmentId, href).catch((cause: unknown) =>
    reportMarkdownExternalOpenFailure(href, cause),
  );
}

// Protocol-relative links (//localhost:5173) navigate with this page's scheme.
function absoluteLinkUrl(href: string): string {
  return href.startsWith("//") ? `${window.location.protocol}${href}` : href;
}

export function markdownLinkNeedsExternalBridge(
  environmentId: EnvironmentId | null,
  href: string,
  altKey: boolean,
): boolean {
  // Editor links also go over IPC: the desktop popup handler only passes web links.
  return (
    (isElectron && (altKey || isLocalEditorFileHref(href))) ||
    markdownLinkNeedsEnvironmentRoute(environmentId, href)
  );
}

/** Middle clicks skip onClick, so loopback and desktop editor links open over the bridge here. */
export function handleMarkdownLinkAuxClick(
  event: { readonly button: number; preventDefault(): void },
  environmentId: EnvironmentId | null,
  href: string | undefined,
): void {
  if (
    event.button !== 1 ||
    !href ||
    !(
      (isElectron && isLocalEditorFileHref(href)) ||
      markdownLinkNeedsEnvironmentRoute(environmentId, href)
    )
  )
    return;
  event.preventDefault();
  openMarkdownLinkInSystemBrowser(environmentId, href);
}
