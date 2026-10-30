import type { ComputerUsePrimitiveReply, ScreenHopTimes, ScreenHostCall } from "@goat/contracts";

/**
 * The proxy's step times of the latest driver call made for a guest call, with what the host
 * measured beyond them. Keyed by the call, so a timing built later in the same dispatch finds it.
 */
const latest = new WeakMap<ScreenHostCall, ScreenHopTimes>();

export const noteHops = (
  call: ScreenHostCall,
  reply: ComputerUsePrimitiveReply,
  totalMs: number,
): void => {
  const hops = reply.hops;
  if (hops === undefined) return;
  const proxied =
    (hops.queueMs ?? 0) + (hops.admitMs ?? 0) + (hops.driverMs ?? 0) + (hops.replyMs ?? 0);
  latest.set(call, { ...hops, channelMs: Math.max(0, totalMs - proxied) });
};

export const hopsOf = (call: ScreenHostCall): ScreenHopTimes | undefined => latest.get(call);
