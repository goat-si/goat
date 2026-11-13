import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { Page } from "playwright-core";
import { vi } from "vite-plus/test";
import type { ServerBrowser } from "./ServerBrowser.ts";
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

export const popupClosedBeforeAdoption = (
  popup: Page,
  service: ServerBrowser["Service"],
  count: number,
) =>
  Effect.raceFirst(
    (popup.isClosed() ? Effect.void : Effect.promise(() => popup.waitForEvent("close"))).pipe(
      Effect.as("closed"),
    ),
    Stream.merge(Stream.succeed(undefined), service.sessionChanges).pipe(
      Stream.mapEffect(() => service.sessions),
      Stream.filter((views) => views.length > count),
      Stream.runHead,
      Effect.as("adopted"),
    ),
  );
