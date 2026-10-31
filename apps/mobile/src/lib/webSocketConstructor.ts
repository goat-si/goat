import type * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";

// Android's OkHttp-backed WebSocket already negotiates permessage-deflate.
export const layerWebSocketConstructor: Layer.Layer<Socket.WebSocketConstructor> =
  Socket.layerWebSocketConstructorGlobal;
