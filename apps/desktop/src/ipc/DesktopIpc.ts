import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as ElectronWindow from "../electron/ElectronWindow.ts";

export interface DesktopIpcInvokeEvent {
  readonly sender: {
    readonly id: number;
    readonly send?: (channel: string, ...args: ReadonlyArray<unknown>) => void;
  };
}

/** The renderer behind a raw IPC message, as Electron reports it. */
export interface DesktopIpcIncomingEvent extends DesktopIpcInvokeEvent {
  readonly sender: DesktopIpcInvokeEvent["sender"] & {
    readonly mainFrame: unknown;
    isDestroyed(): boolean;
  };
  readonly senderFrame: unknown;
}

export interface DesktopIpcSyncEvent extends DesktopIpcIncomingEvent {
  returnValue: unknown;
}

export type DesktopIpcHandleListener = (
  event: DesktopIpcIncomingEvent,
  raw: unknown,
) => unknown | Promise<unknown>;

export type DesktopIpcSyncListener = (event: DesktopIpcSyncEvent) => void;

export interface DesktopIpcMain {
  removeHandler(channel: string): void;
  handle(channel: string, listener: DesktopIpcHandleListener): void;
  removeAllListeners(channel: string): void;
  on(channel: string, listener: DesktopIpcSyncListener): void;
}

export class DesktopIpcRegistrationError extends Schema.TaggedError<DesktopIpcRegistrationError>()(
  "DesktopIpcRegistrationError",
  {
    handlerKind: Schema.Literals(["invoke", "sync"]),
    channel: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to register the ${this.handlerKind} IPC handler for ${this.channel}.`;
  }
}

export class DesktopIpcUnregistrationError extends Schema.TaggedError<DesktopIpcUnregistrationError>()(
  "DesktopIpcUnregistrationError",
  {
    handlerKind: Schema.Literals(["invoke", "sync"]),
    channel: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to unregister the ${this.handlerKind} IPC handler for ${this.channel}.`;
  }
}

export const DesktopIpcError = Schema.Union([
  DesktopIpcRegistrationError,
  DesktopIpcUnregistrationError,
]);
export type DesktopIpcError = typeof DesktopIpcError.Type;

const DesktopIpcSenderRefusal = Schema.Literals([
  "no-main-window",
  "sender-destroyed",
  "untrusted-window",
  "frame-detached",
  "not-top-frame",
]);
type DesktopIpcSenderRefusal = typeof DesktopIpcSenderRefusal.Type;

export class DesktopIpcSenderRefusedError extends Schema.TaggedError<DesktopIpcSenderRefusedError>()(
  "DesktopIpcSenderRefusedError",
  {
    channel: Schema.String,
    reason: DesktopIpcSenderRefusal,
  },
) {
  override get message(): string {
    return `Desktop IPC refused ${this.channel} from an untrusted sender (${this.reason}).`;
  }
}

export interface DesktopIpcTrustedWindow {
  readonly webContents: DesktopIpcIncomingEvent["sender"];
}

// Only the main window loads the desktop preload for itself, and only in its top
// frame, so that frame is the one sender every DesktopIpc channel answers.
// Anything else (a subframe, a webview or other window, the frame of a document
// that has navigated away, a closed or replaced main window) is refused before
// its payload is decoded. A window.open child of the main window may inherit the
// preload, but its UI is rendered by the main window through the opener's bridge.
const findSenderRefusal = (
  event: DesktopIpcIncomingEvent,
  trusted: Option.Option<DesktopIpcTrustedWindow>,
): DesktopIpcSenderRefusal | undefined => {
  if (Option.isNone(trusted)) return "no-main-window";
  try {
    const sender = event.sender;
    if (sender.isDestroyed()) return "sender-destroyed";
    if (sender !== trusted.value.webContents) return "untrusted-window";
    // Electron reports null once the sending frame is gone; a frame still
    // unloading stays non-null but is no longer the current main frame.
    const frame = event.senderFrame;
    if (frame === null || frame === undefined) return "frame-detached";
    if (frame !== sender.mainFrame) return "not-top-frame";
    return undefined;
  } catch {
    // Electron throws when a sender or window is torn down while being inspected.
    return "sender-destroyed";
  }
};

const readSenderId = (event: DesktopIpcIncomingEvent): number | null => {
  try {
    return event.sender.id;
  } catch {
    return null;
  }
};

export interface DesktopIpcMethod<E, R> {
  readonly channel: string;
  readonly handler: (raw: unknown, event?: DesktopIpcInvokeEvent) => Effect.Effect<unknown, E, R>;
}

export interface DesktopSyncIpcMethod<E, R> {
  readonly channel: string;
  readonly handler: () => Effect.Effect<unknown, E, R>;
}

export class DesktopIpc extends Context.Service<
  DesktopIpc,
  {
    readonly handle: <E, R>(
      input: DesktopIpcMethod<E, R>,
    ) => Effect.Effect<void, DesktopIpcRegistrationError, R | Scope.Scope>;
    readonly handleSync: <E, R>(
      input: DesktopSyncIpcMethod<E, R>,
    ) => Effect.Effect<void, DesktopIpcRegistrationError, R | Scope.Scope>;
  }
>()("@goat/desktop/ipc/DesktopIpc") {}

export const make = (
  ipcMain: DesktopIpcMain,
  trustedWindow: Effect.Effect<Option.Option<DesktopIpcTrustedWindow>>,
): DesktopIpc["Service"] => {
  // Runs inside each invoke span, so it adds no span of its own.
  const senderRefusal = Effect.fnUntraced(function* (
    channel: string,
    event: DesktopIpcIncomingEvent,
  ) {
    const reason = findSenderRefusal(event, yield* trustedWindow);
    if (reason !== undefined) {
      yield* Effect.logWarning("desktop IPC refused an untrusted sender", {
        channel,
        reason,
        senderId: readSenderId(event),
      });
    }
    return reason;
  });

  return DesktopIpc.of({
    handle: Effect.fn("desktop.ipc.registerInvoke")(function* <E, R>({
      channel,
      handler,
    }: DesktopIpcMethod<E, R>) {
      yield* Effect.annotateCurrentSpan({ channel });
      const context = yield* Effect.context<R>();
      const runPromise = Effect.runPromiseWith(context);

      yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            ipcMain.removeHandler(channel);
            ipcMain.handle(channel, (event, raw) =>
              runPromise(
                Effect.gen(function* () {
                  yield* Effect.annotateCurrentSpan({ channel });
                  const reason = yield* senderRefusal(channel, event);
                  if (reason !== undefined) {
                    return yield* new DesktopIpcSenderRefusedError({ channel, reason });
                  }
                  return yield* handler(raw, event);
                }).pipe(Effect.annotateLogs({ channel }), Effect.withSpan("desktop.ipc.invoke")),
              ),
            );
          },
          catch: (cause) =>
            new DesktopIpcRegistrationError({ handlerKind: "invoke", channel, cause }),
        }),
        () =>
          Effect.try({
            try: () => ipcMain.removeHandler(channel),
            catch: (cause) =>
              new DesktopIpcUnregistrationError({ handlerKind: "invoke", channel, cause }),
          }).pipe(Effect.orDie),
      );
    }),

    handleSync: Effect.fn("desktop.ipc.registerSync")(function* <E, R>({
      channel,
      handler,
    }: DesktopSyncIpcMethod<E, R>) {
      yield* Effect.annotateCurrentSpan({ channel });
      const context = yield* Effect.context<R>();
      const runSync = Effect.runSyncWith(context);

      yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            ipcMain.removeAllListeners(channel);
            ipcMain.on(channel, (event) => {
              event.returnValue = runSync(
                Effect.gen(function* () {
                  yield* Effect.annotateCurrentSpan({ channel });
                  // sendSync blocks the renderer until it gets a reply, so a refusal
                  // still answers, with null.
                  if ((yield* senderRefusal(channel, event)) !== undefined) return null;
                  return yield* handler();
                }).pipe(
                  Effect.annotateLogs({ channel }),
                  Effect.withSpan("desktop.ipc.invokeSync"),
                ),
              );
            });
          },
          catch: (cause) =>
            new DesktopIpcRegistrationError({ handlerKind: "sync", channel, cause }),
        }),
        () =>
          Effect.try({
            try: () => ipcMain.removeAllListeners(channel),
            catch: (cause) =>
              new DesktopIpcUnregistrationError({ handlerKind: "sync", channel, cause }),
          }).pipe(Effect.orDie),
      );
    }),
  });
};

export const layer = (ipcMain: DesktopIpcMain) =>
  Layer.effect(
    DesktopIpc,
    Effect.gen(function* () {
      const windows = yield* ElectronWindow.ElectronWindow;
      return make(ipcMain, windows.main);
    }),
  );

export interface DesktopIpcMethodRegistration<
  Payload,
  EncodedPayload,
  Result,
  EncodedResult,
  E,
  R,
  PayloadDecodingServices = never,
  PayloadEncodingServices = never,
  ResultDecodingServices = never,
  ResultEncodingServices = never,
> {
  readonly channel: string;
  readonly payload: Schema.Codec<
    Payload,
    EncodedPayload,
    PayloadDecodingServices,
    PayloadEncodingServices
  >;
  readonly result: Schema.Codec<
    Result,
    EncodedResult,
    ResultDecodingServices,
    ResultEncodingServices
  >;
  readonly handler: (input: Payload, event?: DesktopIpcInvokeEvent) => Effect.Effect<Result, E, R>;
}

export const makeIpcMethod = <
  Payload,
  EncodedPayload,
  Result,
  EncodedResult,
  E,
  R,
  PayloadDecodingServices = never,
  PayloadEncodingServices = never,
  ResultDecodingServices = never,
  ResultEncodingServices = never,
>(
  method: DesktopIpcMethodRegistration<
    Payload,
    EncodedPayload,
    Result,
    EncodedResult,
    E,
    R,
    PayloadDecodingServices,
    PayloadEncodingServices,
    ResultDecodingServices,
    ResultEncodingServices
  >,
): DesktopIpcMethod<
  E | Schema.SchemaError,
  R | PayloadDecodingServices | ResultEncodingServices
> => {
  const decode = Schema.decodeUnknownEffect(method.payload);
  const encode = Schema.encodeUnknownEffect(method.result);

  return {
    channel: method.channel,
    handler: (raw, event) =>
      decode(raw).pipe(
        Effect.flatMap((input) => method.handler(input, event)),
        Effect.flatMap(encode),
        Effect.withSpan("desktop.ipc.method", { attributes: { channel: method.channel } }),
      ),
  };
};

export interface DesktopSyncIpcMethodRegistration<
  Result,
  EncodedResult,
  E,
  R,
  ResultDecodingServices = never,
  ResultEncodingServices = never,
> {
  readonly channel: string;
  readonly result: Schema.Codec<
    Result,
    EncodedResult,
    ResultDecodingServices,
    ResultEncodingServices
  >;
  readonly handler: () => Effect.Effect<Result, E, R>;
}

export const makeSyncIpcMethod = <
  Result,
  EncodedResult,
  E,
  R,
  ResultDecodingServices = never,
  ResultEncodingServices = never,
>(
  method: DesktopSyncIpcMethodRegistration<
    Result,
    EncodedResult,
    E,
    R,
    ResultDecodingServices,
    ResultEncodingServices
  >,
): DesktopSyncIpcMethod<E | Schema.SchemaError, R | ResultEncodingServices> => {
  const encode = Schema.encodeUnknownEffect(method.result);

  return {
    channel: method.channel,
    handler: () =>
      method
        .handler()
        .pipe(
          Effect.flatMap(encode),
          Effect.withSpan("desktop.ipc.method", { attributes: { channel: method.channel } }),
        ),
  };
};
