import { requireOptionalNativeModule } from "expo";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";

// SocketRocket, behind React Native's global WebSocket on iOS, never offers
// permessage-deflate, so the GOAT server's frames arrive uncompressed. The
// GoatWebSocket module runs on URLSessionWebSocketTask, which offers it.

interface GoatWebSocketNativeModule {
  connect(id: number, url: string, protocols: Array<string>): void;
  sendText(id: number, text: string): void;
  sendBinary(id: number, base64: string): void;
  close(id: number, code: number, reason: string): void;
  addListener(
    eventName: "onOpen" | "onMessage" | "onClose" | "onError",
    listener: (payload: NativeEventPayload) => void,
  ): { remove(): void };
}

interface NativeEventPayload {
  readonly id: number;
  readonly data?: string;
  readonly binary?: boolean;
  readonly code?: number;
  readonly reason?: string;
  readonly message?: string;
}

type EventType = "open" | "message" | "close" | "error";

interface ListenerEntry {
  readonly listener: (event: Socket.WebSocketEvent) => void;
  readonly once: boolean;
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

const activeSockets = new Map<number, GoatWebSocket>();
let nextSocketId = 1;
let listening = false;

// One native listener per event for the app's lifetime, routed by id.
function listen(native: GoatWebSocketNativeModule) {
  if (listening) return;
  listening = true;
  native.addListener("onOpen", (payload) => activeSockets.get(payload.id)?.handleOpen());
  native.addListener("onMessage", (payload) =>
    activeSockets.get(payload.id)?.handleMessage(payload.data ?? "", payload.binary === true),
  );
  native.addListener("onClose", (payload) =>
    activeSockets.get(payload.id)?.handleClose(payload.code ?? 1006, payload.reason ?? ""),
  );
  native.addListener("onError", (payload) =>
    activeSockets.get(payload.id)?.handleError(payload.message ?? "WebSocket error"),
  );
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return btoa(binary);
}

class GoatWebSocket implements Socket.WebSocketLike {
  readyState = CONNECTING;

  private readonly id = nextSocketId++;
  private readonly listeners = new Map<EventType, Set<ListenerEntry>>();

  constructor(
    private readonly native: GoatWebSocketNativeModule,
    url: string,
    protocols: Array<string>,
  ) {
    activeSockets.set(this.id, this);
    listen(native);
    try {
      native.connect(this.id, url, protocols);
    } catch (error) {
      activeSockets.delete(this.id);
      throw error;
    }
  }

  addEventListener(
    type: EventType,
    listener: (event: Socket.WebSocketEvent) => void,
    options?: { readonly once?: boolean },
  ): void {
    let entries = this.listeners.get(type);
    if (entries === undefined) {
      entries = new Set();
      this.listeners.set(type, entries);
    }
    entries.add({ listener, once: options?.once === true });
  }

  removeEventListener(type: EventType, listener: (event: Socket.WebSocketEvent) => void): void {
    const entries = this.listeners.get(type);
    if (entries === undefined) return;
    for (const entry of entries) {
      if (entry.listener === listener) entries.delete(entry);
    }
  }

  send(data: string | Uint8Array<ArrayBuffer>): void {
    // React Native's WebSocket throws the same error before open.
    if (this.readyState === CONNECTING) throw new Error("INVALID_STATE_ERR");
    if (typeof data === "string") this.native.sendText(this.id, data);
    else this.native.sendBinary(this.id, bytesToBase64(data));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState >= CLOSING) return;
    this.readyState = CLOSING;
    this.native.close(this.id, code, reason);
  }

  handleOpen(): void {
    // A close() while connecting leaves the native connect in flight; its late
    // open must not reopen a socket the caller already gave up on.
    if (this.readyState !== CONNECTING) return;
    this.readyState = OPEN;
    this.dispatch("open", { type: "open" });
  }

  handleMessage(data: string, binary: boolean): void {
    this.dispatch("message", { type: "message", data: binary ? base64ToBytes(data) : data });
  }

  handleClose(code: number, reason: string): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    activeSockets.delete(this.id);
    this.dispatch("close", { type: "close", code, reason });
  }

  handleError(message: string): void {
    this.dispatch("error", Object.assign(new Error(message), { type: "error" }));
  }

  private dispatch(type: EventType, event: Socket.WebSocketEvent): void {
    const entries = this.listeners.get(type);
    if (entries === undefined) return;
    for (const entry of entries) {
      if (entry.once) entries.delete(entry);
      entry.listener(event);
    }
  }
}

const native = requireOptionalNativeModule<GoatWebSocketNativeModule>("GoatWebSocket");

/** A binary built before the module shipped keeps React Native's WebSocket. */
export const layerWebSocketConstructor: Layer.Layer<Socket.WebSocketConstructor> =
  native === null
    ? Socket.layerWebSocketConstructorGlobal
    : Layer.succeed(Socket.WebSocketConstructor)((url, options) => {
        if (options !== undefined && typeof options !== "string" && !Array.isArray(options)) {
          throw new TypeError("WebSocket client options are not supported on iOS");
        }
        return new GoatWebSocket(native, url, options === undefined ? [] : [options].flat());
      });
