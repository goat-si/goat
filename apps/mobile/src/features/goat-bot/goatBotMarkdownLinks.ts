import { scopeThreadRef } from "@goat/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@goat/contracts";
import { parseThreadLinkHref, resolveThreadLinkRef } from "@goat/shared/threadLinks";

import { resolveMarkdownLinkPresentation } from "../../lib/markdownLinks";

export type GoatBotMarkdownLinkTarget =
  | { readonly kind: "thread"; readonly thread: ScopedThreadRef }
  | { readonly kind: "external"; readonly href: string };

/**
 * Where a link in bot text may go: a thread in the shown history's environment, or a web page.
 * Anything else (files, app schemes, scripts) opens nothing, as plain bot text never linked it.
 */
export function goatBotMarkdownLinkTarget(
  href: string,
  environmentId: EnvironmentId | null,
  threadRefs: ReadonlyArray<ScopedThreadRef>,
): GoatBotMarkdownLinkTarget | null {
  const threadId = parseThreadLinkHref(href);
  if (threadId !== null) {
    if (environmentId === null) return null;
    const source = scopeThreadRef(environmentId, threadId);
    return { kind: "thread", thread: resolveThreadLinkRef(source, threadRefs) ?? source };
  }
  const link = resolveMarkdownLinkPresentation(href);
  return link.kind === "external" ? { kind: "external", href: link.href } : null;
}
