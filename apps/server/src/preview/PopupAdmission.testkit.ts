import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { expect, vi } from "vite-plus/test";
import * as PopupAdmission from "./popupAdmission.ts";
import type { PopupFixture } from "./ServerBrowser.popupSetup.test.ts";

export const failedAdoptionClosesPopup = (f: PopupFixture) =>
  Effect.gen(function* () {
    const handled = yield* Deferred.make<void>();
    const inspect = PopupAdmission.inspectPopup;
    const inspection = vi
      .spyOn(PopupAdmission, "inspectPopup")
      .mockImplementation(async (...args) => {
        const result = await inspect(...args);
        return {
          ...result,
          close: () => {
            const closing = result.close();
            const catchClose = closing.catch.bind(closing);
            closing.catch = (onRejected) =>
              catchClose(onRejected).finally(() => Deferred.doneUnsafe(handled, Effect.void));
            return closing;
          },
        };
      });
    const open = vi
      .spyOn(f.manager, "open")
      .mockImplementation(() => Effect.die("forced open failure"));
    const probe = yield* Effect.promise(() => f.page.context().newCDPSession(f.page));
    const session = Object.getPrototypeOf(probe) as { send: (...args: unknown[]) => unknown };
    const send = session.send;
    const closeTarget = vi.spyOn(session, "send").mockImplementation(function (
      this: unknown,
      ...args
    ) {
      if (args[0] === "Target.closeTarget")
        return Promise.reject(new Error("forced CDP close failure"));
      return Reflect.apply(send, this, args);
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closeTarget.mockRestore();
        open.mockRestore();
        inspection.mockRestore();
      }),
    );
    yield* Effect.promise(() =>
      f.page.locator("#next").evaluate((button, url) => {
        button.setAttribute("onclick", `window.open('${url}')`);
      }, `${f.allowed}/safe`),
    );
    const popupReady = f.page.waitForEvent("popup");
    yield* f.call(f.tabId, "click", { locator: "#next" }).pipe(Effect.result);
    const popup = yield* Effect.promise(() => popupReady);
    yield* Deferred.await(handled);
    expect(open).toHaveBeenCalled();
    expect(closeTarget).toHaveBeenCalledWith("Target.closeTarget", expect.anything());
    expect(popup.isClosed()).toBe(true);
  });

export const refusedPopupCloses = (f: PopupFixture) =>
  Effect.gen(function* () {
    for (let i = 1; i < 8; i++)
      yield* f.broker.invoke({
        scope: f.scope,
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
    const probe = yield* Effect.promise(() => f.page.context().newCDPSession(f.page));
    const session = Object.getPrototypeOf(probe) as { send: (...args: unknown[]) => unknown };
    const send = session.send;
    // As when the opener's context closes while its refused popup is being closed.
    const closeTarget = vi.spyOn(session, "send").mockImplementation(function (
      this: unknown,
      ...args
    ) {
      if (args[0] !== "Target.closeTarget") return Reflect.apply(send, this, args);
      return Promise.reject(new Error("Target page, context or browser has been closed"));
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => closeTarget.mockRestore()));
    const popupReady = f.page.waitForEvent("popup");
    yield* f.call(f.tabId, "click", { locator: "#popup" }).pipe(Effect.result);
    const popup = yield* Effect.promise(() => popupReady);
    const closeEvent = yield* Deferred.make<void>();
    if (popup.isClosed()) yield* Deferred.succeed(closeEvent, undefined);
    else popup.once("close", () => Deferred.doneUnsafe(closeEvent, Effect.void));
    yield* Deferred.await(closeEvent);
    expect(closeTarget).toHaveBeenCalledWith("Target.closeTarget", expect.anything());
  });
