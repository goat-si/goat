import type { CDPSession } from "playwright-core";

export const makeOpenRunSignals = () => {
  const pending = new Map<string, Map<AbortSignal, number>>();
  const key = (threadId: string, agentId: string) => `${threadId}\u0000${agentId}`;
  const signal = (threadId: string, agentId: string | undefined) => {
    if (!agentId) return undefined;
    const signals = [...(pending.get(key(threadId, agentId))?.keys() ?? [])];
    return signals.length ? AbortSignal.any(signals) : undefined;
  };
  const track = <A>(
    threadId: string,
    agentId: string,
    run: AbortSignal | undefined,
    work: () => Promise<A>,
  ) => {
    if (!run) return work();
    const id = key(threadId, agentId);
    const signals = pending.get(id) ?? new Map<AbortSignal, number>();
    signals.set(run, (signals.get(run) ?? 0) + 1);
    pending.set(id, signals);
    const release = () => {
      const remaining = (signals.get(run) ?? 1) - 1;
      if (remaining) signals.set(run, remaining);
      else signals.delete(run);
      if (signals.size === 0 && pending.get(id) === signals) pending.delete(id);
    };
    try {
      return work().finally(release);
    } catch (cause) {
      release();
      throw cause;
    }
  };
  return { signal, track };
};

export const openSetupSend = (cdp: CDPSession, signal?: AbortSignal): CDPSession["send"] =>
  ((...args: Parameters<CDPSession["send"]>) => {
    signal?.throwIfAborted();
    return Reflect.apply(cdp.send, cdp, args);
  }) as CDPSession["send"];
