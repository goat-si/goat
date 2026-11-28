// React access to the HostClient (useSyncExternalStore). Host choice: preload `window.goat2Host` or
// `?host=&token=` → real host; `?fake=<scene>` → fake host (verification); otherwise, only in the browser
// prototype, the fake host in demo mode with a visible "Demo" tag.
import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { HostClient, localStorageCache, type HostSnapshot } from "./client.ts";
import { localStorageOutbox, memoryStorage } from "./outbox.ts";
import { OfflineTransport, WebSocketTransport } from "./transport.ts";
import { FakeHost } from "./fakeHost.ts";
import { DEMO_NOW, demoWorld, withQueue } from "./demoWorld.ts";
import { deriveThread, type DerivedThread } from "./store.ts";

export interface Goat2HostConfig { wsUrl: string; token: string; build?: { commit: string; branch: string; builtAt: string } }
declare global { interface Window { goat2Host?: Goat2HostConfig } }

export interface HostContextValue { client: HostClient; now: () => Date; desktop: boolean; build: Goat2HostConfig["build"] | null }
const Ctx = createContext<HostContextValue | null>(null);

export function createHostFromLocation(loc: Location = window.location): HostContextValue {
  const params = new URLSearchParams(loc.search);
  const injected = window.goat2Host;
  const hostParam = params.get("host");
  if (injected || hostParam) {
    const url = injected?.wsUrl ?? hostParam!;
    const token = injected?.token ?? params.get("token") ?? "";
    const client = new HostClient(new WebSocketTransport(url, token), { outbox: localStorageOutbox(), cache: localStorageCache(), demo: null });
    return { client, now: () => new Date(), desktop: injected !== undefined, build: injected?.build ?? null };
  }
  const fakeScene = params.get("fake");
  if (fakeScene === null && import.meta.env.VITE_GOAT2_MODE !== "prototype") {
    // No host configured (e.g. a desktop build whose preload failed): show the real disconnected
    // state with whatever the last session cached. Never a fake host here.
    const client = new HostClient(new OfflineTransport(), { outbox: localStorageOutbox(), cache: localStorageCache(), demo: null });
    return { client, now: () => new Date(), desktop: false, build: null };
  }
  const scene = fakeScene ?? "demo";
  const world = scene === "1MFK-1" ? withQueue(demoWorld()) : demoWorld();
  // Scenes freeze the boards' clock so times read as on the boards; the prototype demo keeps real time.
  const frozen = fakeScene !== null;
  const fake = new FakeHost(world, { connect: scene === "12P-1" ? "never" : "open", now: () => (frozen ? DEMO_NOW : new Date()).toISOString() });
  // 12P-1 is a cold start: the host is not up yet, the UI draws the last session's cache.
  const cache = scene === "12P-1" ? {
    load: () => ({ cards: Object.fromEntries(Object.values(world.threads).map((t) => [t.card.id, t.card])), bots: Object.fromEntries(world.bots.map((b) => [b.botId, b])), lines: { "t-reviewer": world.threads["t-reviewer"]!.lines } }),
    save: () => {},
  } : null;
  const client = new HostClient(fake, { outbox: frozen ? memoryStorage() : localStorageOutbox("goat2.demo.outbox.v1"), cache, demo: scene });
  return { client, now: frozen ? () => DEMO_NOW : () => new Date(), desktop: false, build: null };
}

export function HostProvider({ value, children }: { value: HostContextValue; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useHostContext(): HostContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("HostProvider missing");
  return v;
}
export function useHost(): HostSnapshot {
  const { client } = useHostContext();
  return useSyncExternalStore(client.subscribe, client.getSnapshot);
}
export function useClient(): HostClient { return useHostContext().client; }

/** Subscribe to a thread while mounted; returns its derived view. */
export function useThread(threadId: string | null): DerivedThread & { caughtUp: boolean; hasOlder: boolean } {
  const { client } = useHostContext();
  const snap = useHost();
  useEffect(() => (threadId ? client.watchThread(threadId) : undefined), [client, threadId]);
  const view = threadId ? snap.state.threads[threadId] : undefined;
  return { ...deriveThread(view), caughtUp: view?.caughtUp ?? false, hasOlder: view?.hasOlder ?? false };
}
