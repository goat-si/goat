import { assert, it } from "@effect/vitest";

import { parseTailscaleServeRootHolders } from "./serveRootHolders.ts";

it("finds what holds a Serve port's root", () => {
  const target = { host: "127.0.0.1", port: 3773 };
  const status = JSON.stringify({
    TCP: { "8443": { TCPForward: "127.0.0.1:22" } },
    Web: {
      "box.tailnet.ts.net:443": {
        Handlers: { "/": { Proxy: "http://127.0.0.1:3773" }, "/x": { Proxy: "9000" } },
      },
      "old.tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://[::1]:4000" } } },
      "box.tailnet.ts.net:10000": { Handlers: { "/": { Proxy: "http://127.0.0.1:4001" } } },
      "box.tailnet.ts.net:10001": { Handlers: { "/": { Proxy: "http://10.0.0.5:4002" } } },
      "box.tailnet.ts.net:10002": { Handlers: { "/": { Text: "hi" } } },
    },
    Services: {
      "svc:goat": {
        Web: { "goat.tailnet.ts.net:10000": { Handlers: { "/": { Proxy: "4003" } } } },
      },
    },
  });
  assert.deepEqual(parseTailscaleServeRootHolders(status, 443, target), [
    { ours: true },
    { ours: false, loopback: { host: "::1", port: 4000 } },
  ]);
  assert.deepEqual(parseTailscaleServeRootHolders(status, 10000, target), [
    { ours: false, loopback: { host: "127.0.0.1", port: 4001 } },
  ]);
  assert.deepEqual(parseTailscaleServeRootHolders(status, 10001, target), [{ ours: false }]);
  assert.deepEqual(parseTailscaleServeRootHolders(status, 10002, target), [{ ours: false }]);
  assert.deepEqual(parseTailscaleServeRootHolders(status, 8443, target), [{ ours: false }]);
  assert.deepEqual(parseTailscaleServeRootHolders("null", 443, target), []);
  assert.isUndefined(parseTailscaleServeRootHolders("not json", 443, target));
});
