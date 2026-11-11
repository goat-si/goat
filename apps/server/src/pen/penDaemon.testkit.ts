// @effect-diagnostics nodeBuiltinImport:off -- a fake Pen daemon dials the listener over loopback.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

import { decodeKey32 } from "@goat/pen-protocol/service";
import vector from "@goat/pen-protocol/vectors/service.json" with { type: "json" };
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import type { PenPin } from "./penHandshake.ts";

export { vector };
const vectorKey = decodeKey32(vector.key);
if (vectorKey === null) throw new Error("the shared service vector has no valid key");
export const KEY = vectorKey;
export const PIN: PenPin = { key: KEY, meshId: vector.mesh, nodeId: vector.self };
/** A valid Pen node id made of one letter. */
export const member = (letter: string) => letter.repeat(26);
/** A member's keys follow from its node id, so a reconnect is the same member. */
const key43 = (nodeId: string, use: string) =>
  NodeCrypto.createHash("sha256")
    .update(use + nodeId)
    .digest()
    .toString("base64url");

export const identityLine = (
  nodeId: string,
  overrides: { readonly mesh?: string; readonly self?: string } = {},
) =>
  JSON.stringify({
    v: 1,
    mesh: overrides.mesh ?? PIN.meshId,
    self: overrides.self ?? PIN.nodeId,
    caller: {
      nodeId,
      signPub: key43(nodeId, "sign"),
      noisePub: key43(nodeId, "noise"),
      name: "member-1",
    },
    stream: "goat",
  });

/** The peer the listener proves for a member the fake daemon presents. */
export const peerOf = (nodeId: string) => ({
  meshId: PIN.meshId,
  nodeId,
  signPub: key43(nodeId, "sign"),
  noisePub: key43(nodeId, "noise"),
  name: "member-1",
});

/** B of CONTRACT "Local delivery" step 3, as the daemon computes it. */
export const daemonMac = (key: Uint8Array, nd: Buffer, ng: Buffer, json: string) =>
  NodeCrypto.createHmac("sha256", key)
    .update("pen-svc/1 pen", "ascii")
    .update(nd)
    .update(ng)
    .update(json, "latin1")
    .digest()
    .toString("base64url");

export interface FakeSocket {
  readonly socket: NodeNet.Socket;
  readonly line: () => Effect.Effect<string>;
  readonly closed: Deferred.Deferred<void>;
  readonly received: () => string;
}

/** A client socket with line reads, close tracking and raw writes. */
export const dial = (port: number) =>
  Effect.callback<FakeSocket>((resume) => {
    const socket = NodeNet.connect(port, "127.0.0.1");
    let buffered = "";
    let waiting: (() => void) | undefined;
    const closed = Deferred.makeUnsafe<void>();
    socket.on("data", (chunk) => {
      buffered += chunk.toString("latin1");
      waiting?.();
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      Deferred.doneUnsafe(closed, Effect.void);
      waiting?.();
    });
    socket.once("connect", () =>
      resume(
        Effect.succeed({
          socket,
          closed,
          received: () => buffered,
          line: () =>
            Effect.callback<string>((done) => {
              const check = () => {
                const lf = buffered.indexOf("\n");
                if (lf === -1) return;
                const line = buffered.slice(0, lf);
                buffered = buffered.slice(lf + 1);
                waiting = undefined;
                done(Effect.succeed(line));
              };
              waiting = check;
              check();
            }),
        }),
      ),
    );
  });

export const hello = () => {
  const nd = NodeCrypto.randomBytes(32);
  return { nd, line: "PENSVC/1 " + nd.toString("base64url") + "\n" };
};

/** The daemon's side of the proof; \`after\` goes out in the same write as line 3. */
export const prove = (
  port: number,
  nodeId: string,
  options: { key?: Uint8Array; mesh?: string; self?: string; after?: string } = {},
) =>
  Effect.gen(function* () {
    const client = yield* dial(port);
    const { nd, line } = hello();
    client.socket.write(line);
    const [ngText] = (yield* client.line()).split(" ");
    const ng = Buffer.from(ngText ?? "", "base64url");
    const json = identityLine(nodeId, options);
    client.socket.write(
      json + " " + daemonMac(options.key ?? KEY, nd, ng, json) + "\n" + (options.after ?? ""),
    );
    return client;
  });

/** Reads one whole HTTP response from a connection the server closes after it. */
export const response = (client: FakeSocket) =>
  Deferred.await(client.closed).pipe(
    Effect.map(() => {
      const raw = client.received();
      const head = raw.slice(0, raw.indexOf("\r\n"));
      return {
        status: Number(head.split(" ")[1] ?? 0),
        body: raw.slice(raw.indexOf("\r\n\r\n") + 4),
      };
    }),
  );

export const http = (
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body = "",
) =>
  method +
  " " +
  path +
  " HTTP/1.1\r\nHost: pen\r\nConnection: close\r\nContent-Length: " +
  Buffer.byteLength(body) +
  "\r\n" +
  Object.entries(headers)
    .map(([name, value]) => name + ": " + value + "\r\n")
    .join("") +
  "\r\n" +
  body;
