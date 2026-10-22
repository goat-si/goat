import type {
  ConnectionCatalogHostRequest,
  ConnectionCatalogHostResponse,
  ConnectionCatalogOperation,
  ConnectionCatalogResult,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

export class ConnectionCatalogHostUnavailable extends Schema.TaggedError<ConnectionCatalogHostUnavailable>()(
  "ConnectionCatalogHostUnavailable",
  {},
) {
  override get message(): string {
    return "No desktop connection catalog host is attached.";
  }
}

export class ConnectionCatalogHostDetached extends Schema.TaggedError<ConnectionCatalogHostDetached>()(
  "ConnectionCatalogHostDetached",
  {},
) {
  override get message(): string {
    return "The desktop connection catalog host detached before answering the request.";
  }
}

export class ConnectionCatalogTimeout extends Schema.TaggedError<ConnectionCatalogTimeout>()(
  "ConnectionCatalogTimeout",
  { timeoutMs: Schema.Number },
) {
  override get message(): string {
    return `The desktop connection catalog host did not answer within ${this.timeoutMs} ms.`;
  }
}

type BrokerError =
  | ConnectionCatalogHostUnavailable
  | ConnectionCatalogHostDetached
  | ConnectionCatalogTimeout;

export class ConnectionCatalogBroker extends Context.Service<
  ConnectionCatalogBroker,
  {
    readonly hasHost: Effect.Effect<boolean>;
    readonly attach: (connectionId: string) => Stream.Stream<ConnectionCatalogHostRequest>;
    readonly respond: (
      connectionId: string,
      response: ConnectionCatalogHostResponse,
    ) => Effect.Effect<void>;
    readonly invoke: (
      operation: ConnectionCatalogOperation,
      timeoutMs: number,
    ) => Effect.Effect<ConnectionCatalogResult, BrokerError>;
  }
>()("goat/connections/ConnectionCatalogBroker") {}

const make = Effect.gen(function* () {
  const lock = yield* Semaphore.make(1);
  type Host = {
    readonly connectionId: string;
    readonly queue: Queue.Queue<ConnectionCatalogHostRequest>;
  };
  const hosts = new Set<Host>();
  const pending = new Map<
    string,
    {
      readonly host: Host;
      readonly answer: Deferred.Deferred<ConnectionCatalogResult, BrokerError>;
    }
  >();
  let nextRequestId = 0;

  const detach = (host: Host) =>
    Effect.gen(function* () {
      hosts.delete(host);
      for (const [requestId, request] of pending) {
        if (request.host !== host) continue;
        pending.delete(requestId);
        yield* Deferred.fail(request.answer, new ConnectionCatalogHostDetached());
      }
      yield* Queue.shutdown(host.queue);
    }).pipe(lock.withPermit);

  const attach: ConnectionCatalogBroker["Service"]["attach"] = (connectionId) =>
    Stream.unwrap(
      Effect.acquireRelease(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<ConnectionCatalogHostRequest>();
          const host = { connectionId, queue };
          hosts.add(host);
          return host;
        }).pipe(lock.withPermit),
        detach,
      ).pipe(
        Effect.map((host) =>
          Stream.fromQueue(host.queue).pipe(
            Stream.filter((request) => pending.has(request.requestId)),
          ),
        ),
      ),
    );

  const respond: ConnectionCatalogBroker["Service"]["respond"] = (connectionId, response) =>
    Effect.gen(function* () {
      const request = pending.get(response.requestId);
      if (request === undefined || request.host.connectionId !== connectionId) return;
      pending.delete(response.requestId);
      yield* Deferred.succeed(request.answer, response.result);
    }).pipe(lock.withPermit);

  const invoke: ConnectionCatalogBroker["Service"]["invoke"] = (operation, timeoutMs) =>
    Effect.scoped(
      Effect.gen(function* () {
        const answer = yield* Deferred.make<ConnectionCatalogResult, BrokerError>();
        const requestId = String(++nextRequestId);
        yield* Effect.acquireRelease(
          Effect.gen(function* () {
            // Set insertion order makes the newest live renderer preferred.
            const host = Array.from(hosts).at(-1);
            if (host === undefined) return yield* new ConnectionCatalogHostUnavailable();
            const expiresAt = DateTime.formatIso(
              DateTime.add(yield* DateTime.now, { milliseconds: timeoutMs }),
            );
            pending.set(requestId, { host, answer });
            yield* Queue.offer(host.queue, { requestId, expiresAt, operation });
          }).pipe(lock.withPermit),
          () => Effect.sync(() => pending.delete(requestId)),
        );
        return yield* Deferred.await(answer).pipe(
          Effect.timeoutOrElse({
            duration: timeoutMs,
            orElse: () => Effect.fail(new ConnectionCatalogTimeout({ timeoutMs })),
          }),
        );
      }),
    );

  return ConnectionCatalogBroker.of({
    hasHost: Effect.sync(() => hosts.size > 0).pipe(lock.withPermit),
    attach,
    respond,
    invoke,
  });
});

export const layer = Layer.effect(ConnectionCatalogBroker, make);
