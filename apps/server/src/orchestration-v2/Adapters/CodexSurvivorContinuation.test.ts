import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import type * as CodexClient from "effect-codex-app-server/client";
import { ProviderInstanceId, ProviderSessionId, RunId, ThreadId } from "@goat/contracts";
import { CodexDetachedAppServerError } from "../../provider/CodexDetachedAppServer.ts";
import type { CodexSurvivors } from "../../provider/CodexSurvivors.ts";
import {
  interruptSurvivor,
  makeSurvivorNotifications,
  readSurvivorResult,
} from "./CodexSurvivorContinuation.ts";

it.effect("deduplicates native items repeated across history pages", () =>
  Effect.gen(function* () {
    const result = yield* readSurvivorResult({
      threadId: "thread",
      turnId: "turn",
      readTurns: () => Effect.succeed({ data: [{ id: "turn", status: "completed" }] }),
      readItems: ({ cursor }) =>
        Effect.succeed({
          data: cursor
            ? [
                { turnId: "turn", item: { id: "one" } },
                { turnId: "turn", item: { id: "two" } },
              ]
            : [{ turnId: "turn", item: { id: "one" } }],
          nextCursor: cursor ? null : "next",
        }),
    });
    assert.deepEqual(
      result.items.map((entry) => entry.item.id),
      ["one", "two"],
    );
  }),
);

it.effect("reads all items for the terminal turn and retries one inconsistent snapshot", () =>
  Effect.gen(function* () {
    let reads = 0;
    const result = yield* readSurvivorResult({
      threadId: "thread",
      turnId: "turn",
      readTurns: () =>
        Effect.succeed({ data: [{ id: "turn", status: "completed" }], nextCursor: null }),
      readItems: ({ cursor }) => {
        if (!cursor) reads += 1;
        return Effect.succeed({
          data: [
            {
              turnId: "turn",
              item: { id: cursor ? "two" : "one", text: reads === 1 ? "old" : "new" },
            },
          ],
          nextCursor: cursor ? null : "next",
        });
      },
    });
    assert.equal(reads, 4);
    assert.deepEqual(
      result.items.map((entry) => entry.item.id),
      ["one", "two"],
    );
    assert.equal(result.items[0]?.item.text, "new");
  }),
);

it.effect("fails visibly when terminal history continues to change", () =>
  Effect.gen(function* () {
    let reads = 0;
    const error = yield* readSurvivorResult({
      threadId: "thread",
      turnId: "turn",
      readTurns: () =>
        Effect.succeed({ data: [{ id: "turn", status: "completed" }], nextCursor: null }),
      readItems: () =>
        Effect.sync(() => ({
          data: [{ turnId: "turn", item: { id: "one", text: String(++reads) } }],
          nextCursor: null,
        })),
    }).pipe(Effect.flip);
    assert.equal(
      error.message,
      "Could not read the result of the turn that ran across the restart",
    );
  }),
);

it.effect("a survivor interrupt is sent only after its stop obligation is durable", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const binding = {
      instanceId: ProviderInstanceId.make("codex"),
      recordName: "record",
      threadId: ThreadId.make("thread"),
      nativeThreadId: "native",
      nativeTurnId: "turn",
    };
    yield* interruptSurvivor({
      binding,
      recordStop: () =>
        Effect.sync(() => {
          events.push("record");
        }),
      interrupt: () =>
        Effect.sync(() => {
          events.push("interrupt");
        }),
    });
    assert.deepEqual(events, ["record", "interrupt"]);
    const failure = yield* interruptSurvivor({
      binding,
      recordStop: () => Effect.fail(new CodexDetachedAppServerError({ detail: "disk" })),
      interrupt: () =>
        Effect.sync(() => {
          events.push("unexpected interrupt");
        }),
    }).pipe(Effect.flip);
    assert.equal(
      failure.message,
      "GOAT could not record the stop of the Codex turn from before the restart",
    );
    assert.deepEqual(events, ["record", "interrupt"]);
  }),
);

it.effect("a session tracks only its own process's survivor and resumes only its goals", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("codex");
    const record = (key: string) => ({
      instanceId,
      recordName: "codex-" + key.repeat(12),
      providerSessionId: ProviderSessionId.make("session-" + key),
    });
    const binding = (key: string) => ({
      ...record(key),
      threadId: ThreadId.make("survivor-" + key),
      sourceRunId: RunId.make("run-" + key),
      nativeThreadId: "native-survivor-" + key,
      nativeTurnId: "turn-" + key,
    });
    const goal = (key: string) => ({
      record: record(key),
      block: { threadId: ThreadId.make("goal-" + key), nativeThreadId: "native-goal-" + key },
    });
    const resumed: string[] = [];
    const blocks = [goal("a"), goal("b")];
    const service = {
      list: Effect.succeed([binding("a"), binding("b")]),
      listGoalBlocksByInstance: () => Effect.succeed([goal("a"), goal("b")]),
      getGoalBlocks: (threadId: ThreadId) =>
        Effect.sync(() => blocks.filter((entry) => entry.block.threadId === threadId)),
      getStopObligations: () => Effect.succeed([]),
    } as unknown as CodexSurvivors["Service"];
    const client = {
      setRequestGuard: () => Effect.void,
      handleServerNotification: () => Effect.void,
      request: () => Effect.succeed({ data: [], nextCursor: null, goal: { status: "active" } }),
      raw: {
        request: (method: string, params: { readonly threadId: string }) =>
          Effect.sync(() => {
            if (method === "thread/resume") resumed.push(params.threadId);
            return {};
          }),
      },
    } as unknown as CodexClient.CodexAppServerClient["Service"];
    const notifications = yield* makeSurvivorNotifications({
      client,
      survivors: Option.some(service),
      instanceId,
      providerSessionId: ProviderSessionId.make("session-a"),
      scope: yield* Scope.Scope,
    });
    assert.deepEqual([...notifications.waiting.keys()], ["native-survivor-a"]);
    yield* notifications.resumeGoalThreads;
    assert.deepEqual(resumed, ["native-goal-a"]);
    // Once its fences are ready the session still holds its own persisted goal block, until cleared.
    assert.deepEqual(yield* notifications.fencedGoalThreads, Option.some(["native-goal-a"]));
    blocks.splice(0, 1);
    assert.deepEqual(yield* notifications.fencedGoalThreads, Option.some([]));
  }).pipe(Effect.scoped),
);
