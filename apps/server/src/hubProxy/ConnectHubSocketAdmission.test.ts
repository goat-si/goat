import * as Redacted from "effect/Redacted";
import { expect, it } from "@effect/vitest";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Runtime from "../auth/ConnectHubRuntime.testkit.ts";
import { isPrivilegedConnect } from "../auth/HubConnectAccess.ts";
import { startHub, phoneScopes } from "./testFixtures.ts";

const decodeChunk = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.TaggedStruct("Chunk", {
      requestId: Schema.Number,
      values: Schema.Array(Schema.String),
    }),
  ),
);

const open = Effect.fn("ConnectHubSockets.open")(function* (url: string) {
  const opened = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const frames = yield* Queue.unbounded<string>();
  const socket = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const socket = new NodeWS.WebSocket(url);
      socket.on("open", () => opened.resolve());
      socket.on("close", () => {
        opened.reject(new Error("WebSocket closed before opening."));
        closed.resolve();
      });
      socket.on("error", (cause) => opened.reject(cause));
      socket.on("message", (data) => Queue.offerUnsafe(frames, data.toString()));
      return socket;
    }),
    (socket) => Effect.sync(() => socket.terminate()),
  );
  yield* Effect.promise(() => opened.promise);
  return { socket, frames, closed: Effect.promise(() => closed.promise) };
});
const read = (client: Effect.Success<ReturnType<typeof open>>, id: number) =>
  Effect.sync(() =>
    client.socket.send(
      JSON.stringify({
        _tag: "Request",
        id,
        tag: "orchestration.subscribeThread",
        payload: null,
        headers: [],
      }),
    ),
  ).pipe(
    Effect.andThen(Queue.take(client.frames)),
    Effect.tap((frame) =>
      Effect.sync(() => {
        const chunk = decodeChunk(frame);
        expect(chunk.requestId).toBe(id);
        client.socket.send(JSON.stringify({ _tag: "Ack", requestId: chunk.requestId }));
      }),
    ),
  );

it.effect.each([
  { subscribed: false, doubleFault: false },
  { subscribed: true, doubleFault: false },
  { subscribed: false, doubleFault: true },
  { subscribed: true, doubleFault: true },
])(
  "settings withdrawal closes production hub and proxy sockets (subscribed=$subscribed, double fault=$doubleFault)",
  ({ subscribed, doubleFault }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const acquired = yield* Queue.unbounded<void>();
      const release = yield* Deferred.make<void>();
      let fault = false;
      const watch = yield* Runtime.watcher;
      const runtime = yield* Runtime.open({
        fs: {
          ...watch.fs,
          writeFileString: (file, value, options) =>
            fault && file.endsWith("connect-hub-access.fence.tmp")
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "writeFileString",
                    pathOrDescriptor: file,
                  }),
                )
              : fs.writeFileString(file, value, options),
        },
        access: (access) => {
          const subscribeDenial: typeof access.subscribeDenial = (session) =>
            Effect.gen(function* () {
              if (!isPrivilegedConnect(session)) return yield* access.subscribeDenial(session);
              const stop = subscribed ? yield* access.subscribeDenial(session) : undefined;
              yield* Queue.offer(acquired, undefined);
              yield* Deferred.await(release);
              return stop ?? (yield* access.subscribeDenial(session));
            });
          return {
            ...access,
            subscribeDenial,
            awaitDenial: (session) =>
              Effect.scoped(subscribeDenial(session).pipe(Effect.flatMap((stop) => stop))),
          };
        },
      });
      yield* runtime.settings.start;
      yield* runtime.settings.updateSettings({
        hub: { enabled: true, connectDevicesHubProxy: true },
      });
      yield* Effect.gen(function* () {
        const hub = yield* startHub();
        const cloud = yield* runtime.sessions.issue({
          subject: "cloud-connect",
          scopes: phoneScopes,
          connectAccessGeneration: (yield* runtime.access.current).generation,
        });
        const paired = yield* runtime.auth.issueSession({ scopes: phoneScopes });
        const standard = yield* runtime.auth.issueSession({ subject: "cloud-connect" });
        const url = Effect.fn("ConnectHubSockets.url")(function* (
          session: Parameters<typeof hub.auth.issueWebSocketTicket>[0],
          proxy: boolean,
        ) {
          const ticket = yield* hub.auth.issueWebSocketTicket(session);
          return `${hub.baseUrl.replace(/^http/u, "ws")}${proxy ? "hub/nodes/node-1/" : ""}ws?wsTicket=${encodeURIComponent(Redacted.value(ticket.ticket))}&orchestrationProtocol=1001`;
        });
        const hubSocket = yield* open(yield* url(cloud, false));
        const proxySocket = yield* open(yield* url(cloud, true));
        yield* Queue.take(acquired);
        yield* Queue.take(acquired);
        expect(yield* read(hubSocket, 1)).toContain("hub-stream-value");
        expect(yield* read(proxySocket, 1)).toContain("node-stream-value");
        const pairedSocket = yield* open(yield* url(paired, true));
        const standardSocket = yield* open(yield* url(standard, false));
        expect(yield* read(pairedSocket, 1)).toContain("node-stream-value");
        expect(yield* read(standardSocket, 1)).toContain("hub-stream-value");
        yield* sql`CREATE TRIGGER fail_cloud_session_cleanup BEFORE UPDATE ON auth_sessions WHEN OLD.subject = 'cloud-connect' BEGIN SELECT RAISE(FAIL, 'hygiene held'); END`;
        if (doubleFault) {
          fault = true;
          yield* sql`CREATE TRIGGER fail_connect_bump BEFORE UPDATE ON hub_connect_access BEGIN SELECT RAISE(FAIL, 'generation held'); END`;
        }
        const result = yield* runtime.settings
          .updateSettings({ hub: { connectDevicesHubProxy: false } })
          .pipe(Effect.result);
        expect(result._tag).toBe(doubleFault ? "Failure" : "Success");
        expect(yield* runtime.access.current).toMatchObject({
          allowed: false,
          fenced: doubleFault,
        });
        yield* Deferred.succeed(release, undefined);
        yield* hubSocket.closed;
        yield* proxySocket.closed;
        yield* Queue.take(hub.hubStreamEnded);
        yield* Queue.take(hub.node.streamEnded);
        expect(pairedSocket.socket.readyState).toBe(NodeWS.WebSocket.OPEN);
        expect(standardSocket.socket.readyState).toBe(NodeWS.WebSocket.OPEN);
        expect(yield* read(pairedSocket, 2)).toContain("node-stream-value");
        expect(yield* read(standardSocket, 2)).toContain("hub-stream-value");
      }).pipe(Effect.provideContext(runtime.context));
    }).pipe(Effect.scoped, Effect.provide(Runtime.storage)),
);
