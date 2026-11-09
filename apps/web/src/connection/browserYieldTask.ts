import * as Effect from "effect/Effect";

// MessageChannel yields without nested-timer clamping or background throttling.
export const yieldToBrowserTask = Effect.callback<void>((resume) => {
  const { port1, port2 } = new MessageChannel();
  port1.addEventListener(
    "message",
    () => {
      port1.close();
      resume(Effect.void);
    },
    { once: true },
  );
  port1.start();
  port2.postMessage(null);
  // A closed port delivers nothing, so interruption needs no listener bookkeeping.
  return Effect.sync(() => port1.close());
});
