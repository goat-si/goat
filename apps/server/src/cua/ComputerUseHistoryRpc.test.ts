import { assert, it } from "@effect/vitest";
import { AuthSessionId, ThreadId } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Handoffs from "../handoffs/Handoffs.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { makeComputerUseHistory } from "./ComputerUseHistory.ts";
import { makeComputerUseRpcHandlers } from "./ComputerUseRpcHandlers.ts";

it.effect("history RPC pages only the requested thread", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const history = yield* makeComputerUseHistory;
    const entry = {
      threadId: "thread:a",
      target: { kind: "tab", host: "example.test" },
      verdict: "sent",
    } as const;
    yield* history.record({ ...entry, method: "first" });
    yield* history.record({ ...entry, threadId: "thread:b", method: "other" });
    yield* history.record({ ...entry, method: "second" });
    const handlers = yield* makeComputerUseRpcHandlers(AuthSessionId.make("session:test"));
    const page = yield* handlers["computerUse.history"]({
      threadId: ThreadId.make("thread:a"),
      limit: 1,
    });
    assert.deepEqual(
      page.entries.map((row) => row.method),
      ["second"],
    );
    assert.isNotNull(page.nextCursor);
    if (page.nextCursor === null) return assert.fail("missing cursor");
    const next = yield* handlers["computerUse.history"]({
      threadId: ThreadId.make("thread:a"),
      limit: 1,
      before: page.nextCursor,
    });
    assert.deepEqual(
      next.entries.map((row) => row.method),
      ["first"],
    );
  }).pipe(
    Effect.provide(
      Layer.merge(
        NodeSqliteClient.layer({ filename: ":memory:" }),
        Layer.mock(Handoffs.Handoffs)({}),
      ),
    ),
  ),
);
