import { expect, it } from "vite-plus/test";
import { makeMailbox, publishMailbox, readMailbox } from "./LoopWatchdogWorker.ts";
it("publishes bounded coherent progress and never revives a retired generation", () => {
  const mailbox = makeMailbox();
  expect(publishMailbox(mailbox, "ready")).toBe(true);
  expect(readMailbox(mailbox)).toMatchObject({ sequence: 1, phase: "ready", ready: true });
  Atomics.store(mailbox, 4, 1);
  expect(publishMailbox(mailbox, "ready")).toBe(false);
  expect(readMailbox(mailbox)?.sequence).toBe(1);
});
