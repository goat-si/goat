// The host's provider list and the provider port for the GOAT 2 provider screens. One port per host client
// (hostProviderPort.ts); App creates it, installs it for the v1 seam and provides it here.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { HostProviderPort } from "./hostProviderPort.ts";
import type { ServerProviderEntry } from "./wire.ts";
import type { ProviderPortMethod } from "@v1/surfaces";

interface ProvidersValue { port: HostProviderPort | null; entries: ServerProviderEntry[] | null }
const Ctx = createContext<ProvidersValue>({ port: null, entries: null });

export function ProvidersProvider({ port, children }: { port: HostProviderPort | null; children: ReactNode }) {
  const [entries, setEntries] = useState<ServerProviderEntry[] | null>(null);
  useEffect(() => {
    setEntries(null);
    if (!port) return;
    return port.subscribe((list) => setEntries(list as ServerProviderEntry[]));
  }, [port]);
  return <Ctx.Provider value={{ port, entries }}>{children}</Ctx.Provider>;
}

/** The host's provider entries (null until the first providers frame). */
export const useProviderEntries = () => useContext(Ctx).entries;

/** A provider command by v1 method name (hostProviderPort.toCommand); rejects with the host's sentence. */
export function useProviderCall() {
  const { port } = useContext(Ctx);
  return useCallback(async <T = unknown>(method: ProviderPortMethod, payload: unknown): Promise<T> => {
    if (!port) throw new Error("Not connected to the host.");
    return (await port.call(method, payload)) as T;
  }, [port]);
}

/** Runs actions one at a time per key and keeps the last failure as a sentence for the screen. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (key: string, f: () => Promise<unknown>) => {
    setBusy(key); setError(null);
    try { await f(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }, []);
  return { busy, error, setError, run };
}

