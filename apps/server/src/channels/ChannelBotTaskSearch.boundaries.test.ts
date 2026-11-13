import { assert, describe, it } from "@effect/vitest";
import { BotId, ChannelTaskId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as BotThreads from "./ChannelBotThreads.ts";
import { owner } from "./testkit/ChannelHarness.ts";
import { at, insertTask, provide, setup } from "./testkit/botThreadHistory.fixture.ts";

describe("bot task search boundaries", () => {
  it.effect("rejects a JSON task id belonging to another bot on both reads", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        yield* insertTask("visible", { status: "running", createdAt: at(1) });
        yield* insertTask("foreign", { status: "running", createdAt: at(2), botId: "other" });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE channel_tasks SET task_json = json_set(task_json, '$.taskId', 'foreign') WHERE task_id = 'visible'`;
        const service = yield* BotThreads.ChannelBotThreads;
        const error = yield* Effect.flip(
          service.getBotTask(
            { taskId: ChannelTaskId.make("visible"), botId: BotId.make("main") },
            owner,
          ),
        );
        assert.strictEqual(error.reason, "not_found");
        const page = yield* service.searchBotTasks(
          { botId: BotId.make("main"), query: "visible" },
          owner,
        );
        assert.deepStrictEqual(page.tasks, []);
        assert.strictEqual(page.partial, true);
      }),
    ),
  );
  it.effect("skips an oversized record and continues pagination", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        yield* insertTask("huge", { status: "completed", createdAt: at(1) });
        yield* insertTask("needle", { status: "completed", createdAt: at(2) });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE channel_tasks SET task_json = json_set(task_json, '$.instruction', ${"x".repeat(5_000_000)}) WHERE task_id = 'huge'`;
        const service = yield* BotThreads.ChannelBotThreads;
        const page = yield* service.searchBotTasks(
          { botId: BotId.make("main"), query: "needle", limit: 1 },
          owner,
        );
        assert.strictEqual(page.partial, true);
        assert.deepStrictEqual(
          page.tasks.map((task) => String(task.taskId)),
          ["needle"],
        );
      }),
    ),
  );
  it.effect("ends early when a cursor would contain an empty creation time", () =>
    provide(
      Effect.gen(function* () {
        yield* setup;
        yield* insertTask("b", { status: "completed", createdAt: at(1) });
        yield* insertTask("a", { status: "completed", createdAt: at(2) });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE channel_tasks SET created_at = '', task_json = json_set(task_json, '$.title', 'needle') WHERE task_id IN ('a', 'b')`;
        const service = yield* BotThreads.ChannelBotThreads;
        const page = yield* service.searchBotTasks(
          { botId: BotId.make("main"), query: "needle", limit: 1 },
          owner,
        );
        assert.strictEqual(page.endedEarly, true);
        assert.isUndefined(page.nextCursor);
      }),
    ),
  );
});
