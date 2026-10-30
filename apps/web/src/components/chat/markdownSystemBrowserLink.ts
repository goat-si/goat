import type { EnvironmentId } from "@goat/contracts";

import {
  isEnvironmentUrlUnreachableError,
  openEnvironmentUrlExternally,
  resolveEnvironmentExternalUrl,
} from "~/browser/openEnvironmentUrl";
import { readLocalApi } from "~/localApi";

import { stackedThreadToast, toastManager } from "../ui/toast";
import { reportMarkdownActionFailure } from "./markdownActionFailure";

// Thread links come from the environment, so its loopback servers open at the environment's address.
export function openMarkdownLinkExternally(
  environmentId: EnvironmentId | null,
  target: string,
): Promise<void> {
  if (environmentId !== null) return openEnvironmentUrlExternally(environmentId, target);
  return readLocalApi()?.shell.openExternal(target) ?? Promise.resolve();
}

export function reportMarkdownExternalOpenFailure(target: string, cause: unknown): void {
  reportMarkdownActionFailure({ operation: "open-link-external", target }, cause);
  if (!isEnvironmentUrlUnreachableError(cause)) return;
  toastManager.add(
    stackedThreadToast({ type: "error", title: "Unable to open link", description: cause.message }),
  );
}

/** True when the browser's own navigation to href would land on the wrong machine. */
export function markdownLinkNeedsEnvironmentRoute(
  environmentId: EnvironmentId | null,
  href: string,
): boolean {
  if (environmentId === null) return false;
  const url = absoluteLinkUrl(href);
  const resolved = resolveEnvironmentExternalUrl(environmentId, url);
  return resolved._tag === "Unreachable" || resolved.url !== url;
}

export function openMarkdownLinkInSystemBrowser(environmentId: EnvironmentId | null, href: string) {
  void openMarkdownLinkExternally(environmentId, absoluteLinkUrl(href)).catch((cause: unknown) =>
    reportMarkdownExternalOpenFailure(href, cause),
  );
}

// Protocol-relative links (//localhost:5173) navigate with this page's scheme.
function absoluteLinkUrl(href: string): string {
  return href.startsWith("//") ? `${window.location.protocol}${href}` : href;
}

/** Middle clicks skip onClick, so a loopback link would otherwise open on this device. */
export function handleMarkdownLinkAuxClick(
  event: { readonly button: number; preventDefault(): void },
  environmentId: EnvironmentId | null,
  href: string | undefined,
): void {
  if (event.button !== 1 || !href || !markdownLinkNeedsEnvironmentRoute(environmentId, href))
    return;
  event.preventDefault();
  openMarkdownLinkInSystemBrowser(environmentId, href);
}
