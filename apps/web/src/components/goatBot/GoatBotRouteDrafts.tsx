import {
  createContext,
  use,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { clearBotTemplateDraft, readBotTemplateDraft } from "@goat/client-runtime/goatBot";
import type { EnvironmentId, ThreadId } from "@goat/contracts";

export function useGoatBotDraftSeed(
  destination: string | null,
  environmentId: EnvironmentId | undefined,
  threadId: ThreadId | undefined,
) {
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(() => {
    const text = readBotTemplateDraft(environmentId, threadId);
    return text === undefined ? null : { text, nonce: 0 };
  });
  const [draftFor, setDraftFor] = useState({ destination, generation: 0 });
  if (destination !== null && destination !== draftFor.destination) {
    const changed = draftFor.destination !== null;
    setDraftFor({ destination, generation: draftFor.generation + (changed ? 1 : 0) });
    const text = readBotTemplateDraft(environmentId, threadId);
    if (changed || text !== undefined) setSeed(text === undefined ? null : { text, nonce: 0 });
  }
  const routeDraft = useActivateGoatBotRouteDraft(destination, seed?.text);
  // oxlint-disable-next-line goat/react-effect-budget -- Consume the one-shot draft after the destination commits.
  useEffect(() => {
    clearBotTemplateDraft(environmentId, threadId);
  }, [environmentId, threadId]);
  return { seed, setSeed, draftFor, routeDraft };
}

export interface GoatBotTypedAnswer {
  readonly text: string;
  /** Where the words go once the row no longer says: kept from the row while it did. */
  readonly taskId?: string | undefined;
  readonly questionId?: string | undefined;
  /** Held back on Enter: the main chat hides a task message that names no question. */
  readonly held?: true;
}

type RouteDraft = {
  readonly text: string | null;
  readonly reply: string | null;
  readonly answers: ReadonlyMap<string, GoatBotTypedAnswer>;
};

const EMPTY: RouteDraft = { text: null, reply: null, answers: new Map() };

function createRouteDraft() {
  let destination: string | null = null;
  let draft = EMPTY;
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((listener) => listener());
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    activate(next: string, seed: string | undefined) {
      if (destination === next) return;
      destination = next;
      draft = seed === undefined ? EMPTY : { ...EMPTY, text: seed };
      changed();
    },
    read(key: string) {
      return key === destination ? draft : EMPTY;
    },
    update<K extends keyof RouteDraft>(
      key: string,
      field: K,
      change: (previous: RouteDraft[K]) => RouteDraft[K],
    ) {
      if (key !== destination) return;
      const value = change(draft[field]);
      if (value === draft[field]) return;
      draft = { ...draft, [field]: value };
      changed();
    },
  };
}

const RouteDraftContext = createContext<ReturnType<typeof createRouteDraft> | null>(null);
const ignoreUpdates = () => () => {};

/** One in-memory draft scope per signed-in chat layout, not per route mount. */
export function GoatBotRouteDrafts({ children }: { readonly children: ReactNode }) {
  const [draft] = useState(createRouteDraft);
  return <RouteDraftContext value={draft}>{children}</RouteDraftContext>;
}

export function goatBotDraftDestination(environmentId: string, threadId: string): string {
  return JSON.stringify([environmentId, threadId]);
}

/** A confirmed chat selects the one owner; reconnects never pick a new owner. */
function useActivateGoatBotRouteDraft(destination: string | null, seed?: string) {
  const store = use(RouteDraftContext);
  // oxlint-disable-next-line goat/react-effect-budget -- Publish the confirmed owner to sibling route consumers after commit.
  useLayoutEffect(() => {
    if (destination !== null) store?.activate(destination, seed);
  }, [destination, seed, store]);
  return store;
}

/** Subscribe only to the field used by this surface; typing doesn't redraw the rest of chat. */
export function useGoatBotRouteDraft<K extends keyof RouteDraft>(
  destination: string | null,
  field: K,
) {
  const store = use(RouteDraftContext);
  const [prior, setPrior] = useState(destination);
  if (destination !== null && destination !== prior) setPrior(destination);
  const key = destination ?? prior;
  const value = useSyncExternalStore(
    store?.subscribe ?? ignoreUpdates,
    () => (store !== null && key !== null ? store.read(key)[field] : EMPTY[field]),
    () => EMPTY[field],
  );
  return store !== null && key !== null
    ? {
        value,
        update: (change: (previous: RouteDraft[K]) => RouteDraft[K]) =>
          store.update(key, field, change),
      }
    : null;
}

/** Preserve what the person chose to quote, along with their text. */
export function useGoatBotDraftReply(destination: string | null, identity: string) {
  const [reply, setReply] = useState<{ identity: string; text: string } | null>(null);
  if (reply !== null && reply.identity !== identity) setReply(null);
  const routeReply = useGoatBotRouteDraft(destination, "reply");
  return [
    routeReply === null ? (reply?.identity === identity ? reply.text : null) : routeReply.value,
    (text: string | null) => {
      if (routeReply !== null) routeReply.update(() => text);
      else setReply(text === null ? null : { identity, text });
    },
  ] as const;
}
