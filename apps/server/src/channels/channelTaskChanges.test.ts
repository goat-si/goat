import { assert, describe, it } from "@effect/vitest";
import { CHANNEL_GATEWAY_WS_METHODS, WsChannelRpcGroup } from "@goat/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as RpcTest from "effect/rpc/RpcTest";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Runtime from "../auth/ConnectHubRuntime.testkit.ts";
import * as Authorization from "../auth/RpcAuthorization.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ChannelBotMembers from "./ChannelBotMembers.ts";
import {
  makeChannelTaskChanges,
  MAX_TASK_CHANGE_STREAMS_PER_CONNECTION,
  TASK_CHANGES_COALESCE,
} from "./channelTaskChanges.ts";

/** Revisions an owner's subscriber has seen; the first take is revision 0, once subscribed. */
const watch = (
  changes: Effect.Success<ReturnType<typeof makeChannelTaskChanges>>,
  ownerId: string,
) =>
  Effect.gen(function* () {
    const seen = yield* Queue.unbounded<number>();
    yield* changes.revisions(ownerId).pipe(
      Stream.runForEach((revision) => Queue.offer(seen, revision)),
      Effect.forkChild,
    );
    assert.strictEqual(yield* Queue.take(seen), 0);
    return seen;
  });

describe("channel task change revisions", () => {
  it.effect("a burst of changes to one owner is one revision, and other owners hear nothing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const changes = yield* makeChannelTaskChanges(sql);
      const mine = yield* watch(changes, "owner-a");
      const theirs = yield* watch(changes, "owner-b");
      for (let index = 0; index < 5; index++) yield* changes.announce(["owner-a"]);
      yield* TestClock.adjust(TASK_CHANGES_COALESCE);
      assert.strictEqual(yield* Queue.take(mine), 1);
      yield* TestClock.adjust(Duration.seconds(5));
      assert.isTrue(Option.isNone(yield* Queue.poll(mine)));
      assert.isTrue(Option.isNone(yield* Queue.poll(theirs)));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("keeps a subscriber's own change however many other owners change meanwhile", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const changes = yield* makeChannelTaskChanges(sql);
      const mine = yield* watch(changes, "owner-a");
      yield* changes.announce(["owner-a"]);
      yield* changes.announce(Array.from({ length: 1_000 }, (_, index) => "other-" + index));
      yield* TestClock.adjust(TASK_CHANGES_COALESCE);
      assert.strictEqual(yield* Queue.take(mine), 1);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect(
    "reports a steady stream of changes once per window instead of waiting for a pause",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const changes = yield* makeChannelTaskChanges(sql);
        const mine = yield* watch(changes, "owner-a");
        const step = Duration.millis(100);
        yield* changes.announce(["owner-a"]);
        yield* TestClock.adjust(step);
        yield* changes.announce(["owner-a"]);
        yield* TestClock.adjust(step);
        yield* changes.announce(["owner-a"]);
        // The window opened by the first change closes 250 ms after it, changes still arriving.
        yield* TestClock.adjust(Duration.millis(50));
        assert.strictEqual(yield* Queue.take(mine), 1);
        yield* changes.announce(["owner-a"]);
        yield* TestClock.adjust(TASK_CHANGES_COALESCE);
        assert.strictEqual(yield* Queue.take(mine), 2);
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("a write announces after it commits, never from inside a caller's transaction", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const changes = yield* makeChannelTaskChanges(sql);
      const seen = yield* watch(changes, "owner-a");
      const write = changes.afterCommit(Effect.succeed(1), () => ["owner-a"]);
      // Rolled back: the caller's transaction never committed, so nothing is said.
      yield* sql
        .withTransaction(Effect.andThen(write, Effect.fail("rolled back")))
        .pipe(Effect.ignore);
      yield* TestClock.adjust(Duration.seconds(1));
      assert.isTrue(Option.isNone(yield* Queue.poll(seen)));
      // Committed by a caller: still silent; announcing is that caller's, after its commit.
      yield* sql.withTransaction(write);
      yield* TestClock.adjust(Duration.seconds(1));
      assert.isTrue(Option.isNone(yield* Queue.poll(seen)));
      // On its own, the write's own commit is the outermost one.
      yield* write;
      yield* TestClock.adjust(TASK_CHANGES_COALESCE);
      assert.strictEqual(yield* Queue.take(seen), 1);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});

describe("how many change streams stay open", () => {
  /** Opens one stream and waits for its revision 0; its fiber is returned to close it later. */
  const open = <E>(stream: Stream.Stream<unknown, E>) =>
    Effect.gen(function* () {
      const first = yield* Queue.unbounded<unknown>();
      const fiber = yield* stream.pipe(
        Stream.runForEach((value) => Queue.offer(first, value)),
        Effect.forkChild,
      );
      yield* Queue.take(first);
      return fiber;
    });

  it.effect(
    "refuses a stream over the server's limit and admits one again after another closes",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const changes = yield* makeChannelTaskChanges(sql, 2);
        const one = yield* open(changes.revisions("owner-a"));
        yield* open(changes.revisions("owner-b"));
        const refused = yield* Effect.flip(Stream.runHead(changes.revisions("owner-c")));
        assert.strictEqual(refused.reason, "stream_unavailable");
        yield* Fiber.interrupt(one);
        yield* open(changes.revisions("owner-c"));
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect(
    "refuses a connection's stream over its limit while another connection still opens one",
    () =>
      Effect.gen(function* () {
        const service = { taskChanges: () => Stream.make(0).pipe(Stream.concat(Stream.never)) };
        const handlersFor = () =>
          ChannelBotMembers.rpcHandlers(
            service as unknown as ChannelBotMembers.ChannelBotMembers["Service"],
            { ownerId: "owner-a" } as Parameters<typeof ChannelBotMembers.rpcHandlers>[1],
          )[CHANNEL_GATEWAY_WS_METHODS.subscribeTaskChanges];
        const connection = handlersFor();
        for (let index = 0; index < MAX_TASK_CHANGE_STREAMS_PER_CONNECTION; index++)
          yield* open(connection());
        const refused = yield* Effect.flip(Stream.runHead(connection()));
        assert.strictEqual(refused.reason, "stream_unavailable");
        yield* open(handlersFor()());
      }),
  );

  it.effect("tells the client the stream is unavailable if it ever ends", () =>
    Effect.gen(function* () {
      const handler = ChannelBotMembers.rpcHandlers(
        {
          taskChanges: () => Stream.make(0),
        } as unknown as ChannelBotMembers.ChannelBotMembers["Service"],
        { ownerId: "owner-a" } as Parameters<typeof ChannelBotMembers.rpcHandlers>[1],
      )[CHANNEL_GATEWAY_WS_METHODS.subscribeTaskChanges];
      const seen: number[] = [];
      const ended = yield* Effect.flip(
        Stream.runForEach(handler(), (event) => Effect.sync(() => seen.push(event.revision))),
      );
      assert.deepStrictEqual(seen, [0]);
      assert.strictEqual(ended.reason, "stream_unavailable");
    }),
  );
});

describe("the open asks and their change stream over RPC", () => {
  const { listOpenAsks, subscribeTaskChanges } = CHANNEL_GATEWAY_WS_METHODS;
  const tags = [...WsChannelRpcGroup.requests.values()].map((rpc) => rpc._tag);
  const group = WsChannelRpcGroup.omit(
    ...tags.filter(
      (
        tag,
      ): tag is Exclude<(typeof tags)[number], typeof listOpenAsks | typeof subscribeTaskChanges> =>
        tag !== listOpenAsks && tag !== subscribeTaskChanges,
    ),
  );
  type Service = ChannelBotMembers.ChannelBotMembers["Service"];
  /** One connection: its own handlers, so its own stream limit, under the session's grants. */
  const connect = (service: Partial<Service>, scopes: ReadonlyArray<string>) => {
    const handlers = ChannelBotMembers.rpcHandlers(
      service as Service,
      {
        ownerId: "owner-a",
      } as Parameters<typeof ChannelBotMembers.rpcHandlers>[1],
    );
    return RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.merge(
          group.toLayer(
            group.of({
              [listOpenAsks]: handlers[listOpenAsks],
              [subscribeTaskChanges]: handlers[subscribeTaskChanges],
            }),
          ),
          Authorization.layer(scopes as Parameters<typeof Authorization.layer>[0]),
        ),
      ),
    );
  };
  const first = <A, E>(stream: Stream.Stream<A, E>) =>
    Effect.gen(function* () {
      const seen = yield* Queue.unbounded<A>();
      yield* stream.pipe(
        Stream.runForEach((value) => Queue.offer(seen, value)),
        Effect.forkScoped,
      );
      return yield* Queue.take(seen);
    });

  it.effect("a client over its connection's limit receives the typed refusal", () =>
    Effect.gen(function* () {
      const service = { taskChanges: () => Stream.make(0).pipe(Stream.concat(Stream.never)) };
      const client = yield* connect(service, ["orchestration:read"]);
      for (let index = 0; index < MAX_TASK_CHANGE_STREAMS_PER_CONNECTION; index++)
        assert.deepStrictEqual(yield* first(client[subscribeTaskChanges]({})), { revision: 0 });
      const refused = yield* Effect.flip(Stream.runHead(client[subscribeTaskChanges]({})));
      assert.strictEqual(refused._tag, "ChannelGatewayError");
      assert.strictEqual(
        refused._tag === "ChannelGatewayError" && refused.reason,
        "stream_unavailable",
      );
      // Another connection still gets its stream.
      const other = yield* connect(service, ["orchestration:read"]);
      assert.deepStrictEqual(yield* first(other[subscribeTaskChanges]({})), { revision: 0 });
    }).pipe(Effect.scoped),
  );

  it.effect("a real session without the read grant gets neither asks nor revisions", () =>
    Effect.gen(function* () {
      const runtime = yield* Runtime.open();
      const session = yield* runtime.sessions
        .issue({ scopes: ["providers:manage"] })
        .pipe(Effect.flatMap((issued) => runtime.sessions.verify(issued.token)));
      let reads = 0;
      const service = {
        openAsks: () =>
          Effect.sync(() => {
            reads += 1;
            return { asks: [], total: 0, truncated: false };
          }),
        taskChanges: () =>
          Stream.suspend(() => {
            reads += 1;
            return Stream.make(0).pipe(Stream.concat(Stream.never));
          }),
      };
      const ungranted = yield* connect(service, session.scopes);
      const asks = yield* Effect.flip(ungranted[listOpenAsks]({}));
      assert.strictEqual(asks._tag, "EnvironmentAuthorizationError");
      const revisions: Array<unknown> = [];
      const refused = yield* Effect.flip(
        Stream.runForEach(ungranted[subscribeTaskChanges]({}), (event) =>
          Effect.sync(() => revisions.push(event)),
        ),
      );
      assert.strictEqual(refused._tag, "EnvironmentAuthorizationError");
      assert.deepStrictEqual(revisions, []);
      assert.strictEqual(reads, 0);
      // The same session given the grant reads both.
      const granted = yield* connect(service, [...session.scopes, "orchestration:read"]);
      assert.strictEqual((yield* granted[listOpenAsks]({})).total, 0);
      assert.deepStrictEqual(yield* first(granted[subscribeTaskChanges]({})), { revision: 0 });
      assert.strictEqual(reads, 2);
    }).pipe(Effect.scoped, Effect.provide(Runtime.storage)),
  );
});
