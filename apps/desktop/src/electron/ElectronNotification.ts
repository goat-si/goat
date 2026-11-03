import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Electron from "electron";
import * as NodeEvents from "node:events";

export class ElectronNotification extends Context.Service<
  ElectronNotification,
  {
    readonly show: (
      id: string,
      title: string,
      body: string,
      onClick: Effect.Effect<void>,
      onFailure: (reason: string) => Effect.Effect<void>,
    ) => Effect.Effect<void>;
    readonly close: (id: string) => Effect.Effect<void>;
  }
>()("@goat/desktop/electron/ElectronNotification") {}

export const make = () => {
  const active = new Map<string, { notification: Electron.Notification; cleanup: () => void }>();
  const close = Effect.fn("ElectronNotification.close")((id: string) =>
    Effect.try({
      try: () => {
        const current = active.get(id);
        current?.cleanup();
        current?.notification.close();
      },
      catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    }).pipe(
      Effect.catch((cause) => Effect.logWarning("Could not close desktop notification", { cause })),
    ),
  );
  const show = Effect.fn("ElectronNotification.show")(function* (
    id: string,
    title: string,
    body: string,
    onClick: Effect.Effect<void>,
    onFailure: (reason: string) => Effect.Effect<void>,
  ) {
    const run = Effect.runForkWith(yield* Effect.context<never>());
    yield* Effect.try({
      try: () => {
        const previous = active.get(id);
        previous?.cleanup();
        previous?.notification.close();
        if (!Electron.Notification.isSupported()) throw new Error("notifications unsupported");
        const notification = new Electron.Notification({ title, body });
        const cleanup = () => {
          if (active.get(id)?.notification === notification) active.delete(id);
          notification.removeListener("close", onClose);
          notification.removeListener("click", onClickEvent);
          notification.removeListener("failed", onFailed);
        };
        const onClose = () => cleanup();
        const onClickEvent = () => {
          cleanup();
          run(onClick);
        };
        const onFailed = (_event: Electron.Event, message: string) => {
          cleanup();
          run(onFailure(message));
        };
        NodeEvents.EventEmitter.prototype.on.call(notification, "error", (error: Error) => {
          if (active.get(id)?.notification !== notification) return;
          cleanup();
          run(onFailure(error.message));
        });
        notification.on("close", onClose);
        notification.on("click", onClickEvent);
        notification.on("failed", onFailed);
        active.set(id, { notification, cleanup });
        notification.show();
      },
      catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    }).pipe(
      Effect.catch((reason) =>
        Effect.sync(() => active.get(id)?.cleanup()).pipe(Effect.andThen(onFailure(reason))),
      ),
    );
  });
  return ElectronNotification.of({ show, close });
};
export const layer = Layer.sync(ElectronNotification, make);
