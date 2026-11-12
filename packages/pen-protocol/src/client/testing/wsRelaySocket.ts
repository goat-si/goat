// The Node relay socket factory for tests and scripts: ws with compression off and redirects refused, so it meets
// the factory contract in relayClient.ts (no extension offered, any close code sent, a real bufferedAmount).
import WebSocket from "ws";
import type { RelaySocketFactory, RelaySocketLike } from "../relayClient.ts";

export const wsRelaySocketFactory: RelaySocketFactory = (url) =>
  new WebSocket(url, {
    perMessageDeflate: false,
    followRedirects: false,
  }) as unknown as RelaySocketLike;
