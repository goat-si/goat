import { scopeThreadRef } from "@goat/client-runtime/environment";
import {
  isGoatBotConversationThreadId,
  type ChannelBotRef,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";

import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { isGoatBotThread } from "../../globalAgentRoute";
import { useGlobalAgentStore } from "../../globalAgentStore";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { resolveThreadRouteTarget } from "../../threadRoutes";

const HomeReturnThread = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("server"),
    environmentId: Schema.NonEmptyString,
    threadId: Schema.NonEmptyString,
  }),
  Schema.Struct({ kind: Schema.Literal("draft"), draftId: Schema.NonEmptyString }),
]);
type HomeReturnThread = typeof HomeReturnThread.Type;

const STORAGE_KEY = "goat:home-return-thread:v1";
const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(HomeReturnThread));
const encodeStored = Schema.encodeSync(Schema.fromJsonString(HomeReturnThread));

// Each window remembers its own; storage seeds the next launch, and losing it costs only that.
let remembered: HomeReturnThread | null = null;
const listeners = new Set<() => void>();

function readStored(): HomeReturnThread | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null ? null : Option.getOrNull(decodeStored(raw));
  } catch {
    return null;
  }
}

function remember(next: HomeReturnThread | null) {
  remembered = next;
  for (const listener of listeners) listener();
  try {
    if (next === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, encodeStored(next));
  } catch {
    // Blocked or full storage: this window still remembers.
  }
}

const serverTarget = (ref: ScopedThreadRef): HomeReturnThread => ({
  kind: "server",
  environmentId: ref.environmentId,
  threadId: ref.threadId,
});

type RouteParams = Partial<Record<"environmentId" | "threadId" | "draftId", string | undefined>>;

/** A thread or draft route Home returns to: any but a GOAT Bot conversation, which the bot opens. */
export function isHomeThreadRoute(params: RouteParams, botRef: ChannelBotRef | null): boolean {
  const target = resolveThreadRouteTarget(params);
  if (target?.kind !== "server") return target !== null;
  const { environmentId, threadId } = target.threadRef;
  return (
    !isGoatBotConversationThreadId(threadId) &&
    !isGoatBotThread({ environmentId, id: threadId }, botRef)
  );
}

function homeReturnThreadAt(params: RouteParams): HomeReturnThread | null {
  if (!isHomeThreadRoute(params, useGlobalAgentStore.getState().botRef)) return null;
  const target = resolveThreadRouteTarget(params);
  if (target?.kind === "server") return serverTarget(target.threadRef);
  if (target?.kind !== "draft") return null;
  const session = useComposerDraftStore.getState().getDraftSession(target.draftId);
  if (session === null) return null;
  return { kind: "draft", draftId: target.draftId };
}

function sameTarget(left: HomeReturnThread | null, right: HomeReturnThread) {
  if (left === null || left.kind !== right.kind) return false;
  return left.kind === "draft"
    ? right.kind === "draft" && left.draftId === right.draftId
    : right.kind === "server" &&
        left.environmentId === right.environmentId &&
        left.threadId === right.threadId;
}

const isBotTarget = (target: HomeReturnThread | null, botRef: ChannelBotRef | null) =>
  target?.kind === "server" &&
  isGoatBotThread({ environmentId: target.environmentId, id: target.threadId }, botRef);

/**
 * Remembers the last thread or draft for Home. A remembered draft becomes its thread only
 * once its send succeeds and finalizing drops the draft; a failed send restores the draft.
 * GOAT can learn its main bot's thread after it opened, so the target it replaced is kept
 * to return to once that thread turns out to be the bot's.
 */
export function startHomeReturnMemory(): {
  readonly record: (params: RouteParams) => void;
  readonly stop: () => void;
} {
  const stored = readStored();
  remember(isBotTarget(stored, useGlobalAgentStore.getState().botRef) ? null : stored);
  let replaced: HomeReturnThread | null = null;
  // Where each kept draft is being sent, until its session is dropped or the send fails.
  const sending = new Map<string, ScopedThreadRef>();
  const settle = (target: HomeReturnThread | null): HomeReturnThread | null => {
    if (target?.kind !== "draft") return target;
    const session = useComposerDraftStore.getState().getDraftSession(target.draftId as DraftId);
    const sentTo = sending.get(target.draftId);
    if (session === null) {
      sending.delete(target.draftId);
      return sentTo ? serverTarget(sentTo) : target;
    }
    if (session.promotedTo) sending.set(target.draftId, session.promotedTo);
    else sending.delete(target.draftId);
    return target;
  };
  const followSentDrafts = () => {
    replaced = settle(replaced);
    const next = settle(remembered);
    if (next !== remembered) remember(next);
  };
  followSentDrafts();
  const unsubscribeDrafts = useComposerDraftStore.subscribe(followSentDrafts);
  const unsubscribeBot = useGlobalAgentStore.subscribe((state) => {
    if (!isBotTarget(remembered, state.botRef)) return;
    remember(replaced);
    replaced = null;
  });
  return {
    record: (params) => {
      const next = homeReturnThreadAt(params);
      if (next === null || sameTarget(remembered, next)) return;
      replaced = remembered;
      remember(next);
      followSentDrafts();
    },
    stop: () => {
      unsubscribeDrafts();
      unsubscribeBot();
      remembered = null;
      for (const listener of listeners) listener();
    },
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getRemembered = () => remembered;

export type HomeRailDestination =
  | { readonly kind: "thread"; readonly environmentId: EnvironmentId; readonly threadId: ThreadId }
  | { readonly kind: "draft"; readonly draftId: DraftId }
  | { readonly kind: "landing" };

const LANDING: HomeRailDestination = { kind: "landing" };

/**
 * Where Home leads: the remembered thread or draft while it can still open, else "/".
 * A thread missing from the shell list may be an older settled one, so its own route
 * settles it; the rail never loads thread details.
 */
export function useHomeRailDestination(): HomeRailDestination {
  const target = useSyncExternalStore(subscribe, getRemembered);
  const draftId = target?.kind === "draft" ? (target.draftId as DraftId) : null;
  const draft = useComposerDraftStore((store) =>
    draftId === null ? null : store.getDraftSession(draftId),
  );
  const threadRef =
    target?.kind === "server"
      ? scopeThreadRef(target.environmentId as EnvironmentId, target.threadId as ThreadId)
      : null;
  const shell = useQuietThreadShell(threadRef);
  const { isReady, environments } = useEnvironments();

  const environmentId = threadRef?.environmentId ?? draft?.environmentId ?? null;
  if (environmentId === null) return LANDING;
  if (isReady && !environments.some((entry) => entry.environmentId === environmentId)) {
    return LANDING;
  }
  if (draftId !== null) return { kind: "draft", draftId };
  if (threadRef === null || shell?.archivedAt != null || shell?.deletedAt != null) return LANDING;
  return { kind: "thread", ...threadRef };
}
