import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";
import { SessionControl } from "./SessionControl.ts";

/** Completes once SessionControl.cutBlockedUrl has run on any tab; the spy ends with the scope. */
export const cutBlockedUrlObserved = Effect.gen(function* () {
  const observed = yield* Deferred.make<void>();
  const cut = SessionControl.prototype.cutBlockedUrl;
  const spy = vi.spyOn(SessionControl.prototype, "cutBlockedUrl").mockImplementation(function (
    this: SessionControl,
  ) {
    cut.call(this);
    Deferred.doneUnsafe(observed, Effect.void);
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
  return observed;
});
