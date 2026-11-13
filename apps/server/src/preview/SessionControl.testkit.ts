import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";
import type { PreviewManager } from "./Manager.ts";
import { popupAdmission } from "./popupAdmission.ts";
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

export const popupAdmissionObserved = (manager: PreviewManager["Service"]) =>
  Effect.gen(function* () {
    const outcome = yield* Deferred.make<"refused" | "adopted">();
    const refuse = popupAdmission.refuse;
    const refusal = vi.spyOn(popupAdmission, "refuse").mockImplementation(async (close) => {
      await refuse(close);
      Deferred.doneUnsafe(outcome, Effect.succeed("refused"));
    });
    const open = manager.open;
    const adoption = vi.spyOn(manager, "open").mockImplementation((input) =>
      open({
        ...input,
        beforePublish: (snapshot) => {
          input.beforePublish?.(snapshot);
          Deferred.doneUnsafe(outcome, Effect.succeed("adopted"));
        },
      }),
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        refusal.mockRestore();
        adoption.mockRestore();
      }),
    );
    return outcome;
  });
