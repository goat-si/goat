import { expect, it } from "vite-plus/test";
import { coalescedRun } from "./coalescedRun";

it("reads a native handoff arriving during a read and coalesces overlapping resumes", async () => {
  const firstRead = Promise.withResolvers<void>();
  const nextStarted = Promise.withResolvers<void>();
  const secondRead = Promise.withResolvers<void>();
  let reads = 0;
  const refresh = coalescedRun(() => {
    reads += 1;
    if (reads === 1) return firstRead.promise;
    nextStarted.resolve();
    return secondRead.promise;
  });
  const first = refresh();
  const resumed = refresh();
  expect(refresh()).toBe(resumed);
  expect(reads).toBe(1);
  firstRead.resolve();
  await nextStarted.promise;
  expect(reads).toBe(2);
  secondRead.resolve();
  await Promise.all([first, resumed]);
});

it("retries after a failed read and reports the queued read's failure", async () => {
  const firstRead = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  const secondRead = Promise.withResolvers<void>();
  let reads = 0;
  const refresh = coalescedRun(() => {
    if (++reads === 1) return firstRead.promise;
    secondStarted.resolve();
    return secondRead.promise;
  });
  const first = refresh();
  const firstFailure = expect(first).rejects.toThrow("first failed");
  const resumed = refresh();
  const secondFailure = expect(resumed).rejects.toThrow("next failed");
  firstRead.reject(new Error("first failed"));
  await secondStarted.promise;
  secondRead.reject(new Error("next failed"));
  await Promise.all([firstFailure, secondFailure]);
  expect(reads).toBe(2);
});
