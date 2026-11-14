import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import { RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import { ChannelChildWork } from "./channelChildWork.ts";
import {
  ChannelListBotThreadsInput,
  ChannelListBotThreadsResult,
  ChannelUpdateTaskViewInput,
  ChannelSearchBotTasksInput,
} from "./channelGateway.ts";
import { BotId } from "./botProfile.ts";
import { ChannelRpcs } from "./channelRpc.ts";

const decodeRows = Schema.decodeUnknownSync(ChannelListBotThreadsResult);
const decodeUpdate = Schema.decodeUnknownSync(ChannelUpdateTaskViewInput);
const decodeChild = Schema.decodeUnknownSync(ChannelChildWork);
const encodeChild = Schema.encodeSync(ChannelChildWork);
// The result as clients before remoteWork decoded it.
const decodeRowsBefore = Schema.decodeUnknownSync(
  Schema.Struct({
    rows: ChannelListBotThreadsResult.fields.rows,
    mainMessageCount: ChannelListBotThreadsResult.fields.mainMessageCount,
  }),
);
const at = "2026-11-04T10:00:00.000Z";

describe("bot thread contracts", () => {
  it.effect("rejects a NUL query at the RPC boundary the same way as an invalid limit", () =>
    Effect.gen(function* () {
      const rpc = ChannelRpcs.requests.get("channel.searchBotTasks") as
        | Extract<RpcGroup.Rpcs<typeof ChannelRpcs>, { readonly _tag: "channel.searchBotTasks" }>
        | undefined;
      if (rpc === undefined) throw new Error("missing search RPC");
      const group = RpcGroup.make(rpc);
      const disconnects = yield* Queue.unbounded<number>();
      const replies = yield* Queue.unbounded<unknown>();
      const ready = yield* Deferred.make<Parameters<RpcServer.Protocol["Service"]["run"]>[0]>();
      let handled = 0;
      const protocol = RpcServer.Protocol.of({
        run: (receive) => Deferred.succeed(ready, receive).pipe(Effect.andThen(Effect.never)),
        disconnects,
        send: (_client, response) => Queue.offer(replies, response).pipe(Effect.asVoid),
        end: () => Effect.void,
        clientIds: Effect.succeed(new Set()),
        initialMessage: Effect.succeedNone,
        supportsAck: false,
        supportsTransferables: false,
        supportsSpanPropagation: false,
        supportsNotifications: false,
        codecFor: RpcSerialization.json.codecFor,
      });
      yield* RpcServer.make(group).pipe(
        Effect.provideService(RpcServer.Protocol, protocol),
        Effect.provide(
          group.toLayerHandler("channel.searchBotTasks", () =>
            Effect.sync(() => {
              handled++;
              return { tasks: [] };
            }),
          ),
        ),
        Effect.forkScoped,
      );
      const receive = yield* Deferred.await(ready);
      const send = (id: string, payload: unknown) =>
        receive(0, { _tag: "Request", id, tag: "channel.searchBotTasks", payload, headers: [] });
      yield* send("1", { botId: "main", query: "abc\0zzz" });
      const nul = yield* Queue.take(replies);
      yield* send("2", { botId: "main", query: "abc", limit: 51 });
      const limit = yield* Queue.take(replies);
      expect(handled).toBe(0);
      expect(nul).toMatchObject({ _tag: "Exit", exit: { _tag: "Failure" } });
      expect(limit).toMatchObject({ _tag: "Exit", exit: { _tag: "Failure" } });
      expect((nul as { exit: { cause: { _tag: string } } }).exit.cause._tag).toBe(
        (limit as { exit: { cause: { _tag: string } } }).exit.cause._tag,
      );
    }),
  );
  it("round trips known and unavailable lookup results through the RPC success codec", () => {
    const rpc = ChannelRpcs.requests.get("channel.getBotTask");
    if (rpc === undefined) throw new Error("missing lookup RPC");
    const codec = Schema.toCodecJson(rpc.successSchema);
    const encode = Schema.encodeSync(codec);
    const decode = Schema.decodeUnknownSync(codec);
    const task = { taskId: "task-1", title: "Review", status: "running", updatedAt: at };
    const coding = {
      kind: "coding",
      taskId: "task-1",
      environmentId: "env",
      threadId: "thread",
      state: "bound",
      lastActivityAt: at,
    };
    const remote = {
      childWorkId: "child",
      taskId: "task-1",
      callerThreadId: "caller",
      host: "box",
      state: "bound",
      lastActivityAt: at,
    };
    const view = { taskId: "task-1", pinnedAt: null, doneAt: null, readThrough: null };
    for (const result of [
      {
        task: {
          state: "known",
          row: {
            kind: "task",
            task,
            view,
            lastActivityAt: at,
            unread: true,
            mainMessagesSinceQuiet: 1,
          },
        },
        codingRows: [coding],
        remoteWork: [remote],
        launchesTruncated: false,
        partial: false,
      },
      {
        task: { state: "unavailable", task },
        codingRows: [coding],
        remoteWork: [remote],
        launchesTruncated: false,
        partial: true,
      },
    ])
      expect(decode(encode(decode(result)))).toEqual(result);
  });
  it("rejects a NUL in a bot task search query", () => {
    const decode = Schema.decodeUnknownSync(ChannelSearchBotTasksInput);
    expect(() => decode({ botId: "main", query: "abc\0zzz" })).toThrow();
    expect(() => decode({ botId: "main", query: "abc", limit: 51 })).toThrow();
  });
  it("bounds a history cursor, and an older server's input drops the history key", () => {
    const decodeInput = Schema.decodeUnknownSync(ChannelListBotThreadsInput);
    expect(
      decodeInput({ history: { cursor: "v1." + "a".repeat(509) } }).history?.cursor,
    ).toHaveLength(512);
    expect(() => decodeInput({ history: { cursor: "v1." + "a".repeat(510) } })).toThrow();
    // RpcServer decodes payloads with the default onExcessProperty, "ignore".
    const decodeOlder = Schema.decodeUnknownSync(
      Schema.Struct({ botId: Schema.optionalKey(BotId) }),
    );
    expect(decodeOlder({ botId: "helper", history: { cursor: "v1.x" } })).toEqual({
      botId: "helper",
    });
  });

  it("decodes task views and coding destinations without the full ledger record", () => {
    const result = decodeRows({
      mainMessageCount: 10,
      rows: [
        {
          kind: "task",
          task: { taskId: "task-1", title: "Review", status: "waiting_input", updatedAt: at },
          view: { taskId: "task-1", pinnedAt: null, doneAt: null, readThrough: null },
          lastActivityAt: at,
          unread: true,
          mainMessagesSinceQuiet: 9,
        },
        {
          kind: "coding",
          taskId: "task-1",
          environmentId: "env-1",
          threadId: "thread-1",
          title: "",
          state: "bound",
          lastActivityAt: at,
        },
      ],
    });
    expect(result.rows.map((row) => row.kind)).toEqual(["task", "coding"]);
    expect(
      decodeUpdate({ taskId: "task-1", pinned: true, done: false, readThrough: at }),
    ).toMatchObject({ pinned: true, done: false });
  });
  it("rejects malformed task views and negative message counts", () => {
    expect(() => decodeUpdate({ taskId: "task-1", readThrough: 42 })).toThrow();
    expect(() => decodeRows({ rows: [], mainMessageCount: -1 })).toThrow();
  });
  it("carries the bot's work on other machines beside its rows, which older clients ignore", () => {
    const remoteWork = [
      {
        childWorkId: "cw-1",
        taskId: "task-1",
        callerThreadId: "channel-worker:task-1",
        host: "box",
        state: "bound",
        lastActivityAt: at,
        threadId: "thread-1",
        environmentId: "env-box",
        workKind: "chore",
      },
      {
        childWorkId: "cw-2",
        taskId: "task-1",
        callerThreadId: "channel-worker:task-1",
        host: "mac",
        state: "unknown",
        lastActivityAt: at,
      },
    ];
    expect(decodeRows({ rows: [], mainMessageCount: 0, remoteWork }).remoteWork).toEqual(
      remoteWork,
    );
    expect(decodeRows({ rows: [], mainMessageCount: 0 }).remoteWork).toBeUndefined();
    expect(decodeRowsBefore({ rows: [], mainMessageCount: 0, remoteWork })).toEqual({
      rows: [],
      mainMessageCount: 0,
    });
  });
  it("reads child work records stored before destinations kept a remote identity", () => {
    const stored = {
      childWorkId: "cw-1",
      ownerId: "owner",
      taskId: "task-1",
      generation: 1,
      surface: "ssh_thread_launch",
      callerThreadId: "channel-worker:task-1",
      requestKey: "key",
      promptDigest: "digest",
      state: "bound",
      destination: { correlationId: "cw-corr", host: "box" },
      createdAt: at,
      updatedAt: at,
    };
    expect(decodeChild(stored).destination).toEqual({ correlationId: "cw-corr", host: "box" });
    const bound = {
      ...stored,
      destination: {
        ...stored.destination,
        threadId: "thread-1",
        environmentId: "env-box",
        workKind: "chore",
      },
    };
    expect(encodeChild(decodeChild(bound))).toEqual(bound);
  });
});
