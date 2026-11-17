import { scopeThreadRef } from "@goat/client-runtime/environment";
import type { AssistantCitation, ScopedThreadRef, ThreadId } from "@goat/contracts";
import { useLocation, useRouter, type AnyRouter } from "@tanstack/react-router";
import {
  formatAssistantCitationHref,
  parseAssistantCitationHref,
} from "@goat/shared/assistantCitations";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";
import { useEffect } from "react";

import { useRightPanelStore } from "../rightPanelStore";
import { useQuietThreadShell } from "../state/entities";
import { randomUUID } from "./utils";

declare module "@tanstack/react-router" {
  interface HistoryState {
    assistantCitationActivation?: string;
  }
}

const CITATION_HASH_PREFIX = "assistant-citation=";

/** Base64url keeps router hash normalization from decoding quote whitespace or source IDs. */
function assistantCitationHash(citation: AssistantCitation) {
  return `${CITATION_HASH_PREFIX}${Base64Url.encode(formatAssistantCitationHref(citation))}`;
}

export function assistantCitationFromLocation(href: string) {
  const hashIndex = href.indexOf("#");
  if (hashIndex === -1) return null;
  const hash = href.slice(hashIndex + 1);
  if (!hash.startsWith(CITATION_HASH_PREFIX) || hash.length > 140_000) return null;
  try {
    return parseAssistantCitationHref(
      Result.getOrThrow(Base64Url.decodeString(hash.slice(CITATION_HASH_PREFIX.length))),
    );
  } catch {
    return null;
  }
}

/** Return paths drop the quote hash so going back does not reveal its source again. */
export function withoutAssistantCitationHash(href: string) {
  const hashIndex = href.indexOf("#");
  if (hashIndex === -1 || !href.startsWith(CITATION_HASH_PREFIX, hashIndex + 1)) return href;
  return href.slice(0, hashIndex);
}

/** The thread a quote came from, as far as it is known: a side chat names its parent. */
type SourceThread = { readonly sideChatOf?: ThreadId | null | undefined } | null;

/** Side chat quotes open on their parent thread, where the side chat is a tab. */
export function assistantCitationRoute(
  citation: AssistantCitation,
  sourceThread: SourceThread = null,
) {
  return {
    to: "/$environmentId/$threadId" as const,
    params: {
      environmentId: citation.environmentId,
      threadId: sourceThread?.sideChatOf ?? citation.threadId,
    },
    hash: assistantCitationHash(citation),
    resetScroll: false,
  };
}

/** A fresh activation lets the same link reveal its source again after dismissal. */
export function assistantCitationNavigation(
  citation: AssistantCitation,
  sourceThread: SourceThread = null,
) {
  return {
    ...assistantCitationRoute(citation, sourceThread),
    state: { assistantCitationActivation: randomUUID() },
  };
}

/**
 * Reveals the location's side chat quote in the side chat tab of `parentThreadId`, moving off the
 * side chat's own route. Links, reloads and late-loading shells all land here, not only clicks.
 */
export function revealSideChatCitation(
  router: Pick<AnyRouter, "navigate" | "state">,
  routeThreadRef: ScopedThreadRef,
  sideChatThreadId: ThreadId,
  parentThreadId: ThreadId,
  activation: string,
) {
  const { location } = router.state;
  const citation = assistantCitationFromLocation(location.href);
  if (
    citation === null ||
    citation.threadId !== sideChatThreadId ||
    citation.environmentId !== routeThreadRef.environmentId ||
    (routeThreadRef.threadId !== parentThreadId && routeThreadRef.threadId !== citation.threadId)
  ) {
    return;
  }
  useRightPanelStore
    .getState()
    .open(scopeThreadRef(citation.environmentId, parentThreadId), "side-chat");
  if (routeThreadRef.threadId === parentThreadId) return;
  return router.navigate({
    to: "/$environmentId/$threadId",
    params: { environmentId: citation.environmentId, threadId: parentThreadId },
    hash: true,
    state: (state) => ({ ...state, assistantCitationActivation: activation }),
    replace: true,
    resetScroll: false,
  });
}

/** Called by the routed thread view, which is the one place a side chat quote can land. */
function useSideChatCitationReveal(
  routeThreadRef: ScopedThreadRef | null,
  citation: AssistantCitation | null,
  activation: string,
) {
  const router = useRouter();
  const sourceRef =
    routeThreadRef && citation?.environmentId === routeThreadRef.environmentId
      ? scopeThreadRef(citation.environmentId, citation.threadId)
      : null;
  const parentThreadId = useQuietThreadShell(sourceRef)?.sideChatOf ?? null;
  const environmentId = routeThreadRef?.environmentId;
  const threadId = routeThreadRef?.threadId;
  const sideChatThreadId = sourceRef?.threadId;
  // oxlint-disable-next-line goat/react-effect-budget -- moves a side chat quote's router location and parent right panel once per activation, including after its shell loads
  useEffect(() => {
    if (
      environmentId === undefined ||
      threadId === undefined ||
      sideChatThreadId === undefined ||
      parentThreadId === null
    ) {
      return;
    }
    void revealSideChatCitation(
      router,
      scopeThreadRef(environmentId, threadId),
      sideChatThreadId,
      parentThreadId,
      activation,
    );
  }, [router, environmentId, threadId, sideChatThreadId, parentThreadId, activation]);
}
/** Mounted beside the routed thread so only it, not the thread view, follows the location. */
export function SideChatCitationReveal(props: { readonly threadRef: ScopedThreadRef | null }) {
  const href = useLocation({ select: (location) => location.href });
  const activation = useLocation({
    select: (location) => location.state.assistantCitationActivation ?? location.state.__TSR_key,
  });
  useSideChatCitationReveal(
    props.threadRef,
    assistantCitationFromLocation(href),
    activation ?? href,
  );
  return null;
}
