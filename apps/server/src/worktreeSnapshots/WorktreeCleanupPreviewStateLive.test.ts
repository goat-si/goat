import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import migration from "../persistence/Migrations/133_WorktreeSnapshots.ts";
import { WorktreeCleanupPreviewState } from "./WorktreeCleanupPreviewState.ts";
import * as Live from "./WorktreeCleanupPreviewStateLive.ts";

const day = 86_400_000;
it.effect(
  "persists acknowledgements, rejects stale generations, and gates SSH until confirmation",
  () =>
    Effect.gen(function* () {
      yield* migration;
      const first = yield* Effect.provide(WorktreeCleanupPreviewState, Live.layer);
      const input = { nowMs: 0, plannedCount: 2, requiresConfirmation: false };
      const initial = yield* first.evaluate(input);
      assert.isFalse(initial.apply);
      const id = initial.preview?.id ?? "";
      yield* first.respond({ previewId: id, response: "seen", nowMs: 10 });
      const restarted = yield* Effect.provide(WorktreeCleanupPreviewState, Live.layer);
      assert.equal(
        (yield* restarted.evaluate({ ...input, nowMs: day + 9 })).preview?.activatesAt,
        "1970-01-02T00:00:00.010Z",
      );
      const expanded = yield* restarted.evaluate({ ...input, nowMs: day + 10, plannedCount: 3 });
      assert.notEqual(expanded.preview?.id, id);
      assert.isNull(expanded.preview?.seenAt);
      assert.equal(
        (yield* Effect.exit(
          restarted.respond({ previewId: id, response: "confirm", nowMs: day + 10 }),
        ))._tag,
        "Failure",
      );
      const nextId = expanded.preview?.id ?? "";
      yield* restarted.respond({ previewId: nextId, response: "seen", nowMs: day + 20 });
      const ssh = yield* restarted.evaluate({
        ...input,
        nowMs: day * 5,
        plannedCount: 3,
        requiresConfirmation: true,
      });
      assert.isFalse(ssh.apply);
      assert.isNull(ssh.preview?.activatesAt);
      yield* restarted.respond({ previewId: nextId, response: "confirm", nowMs: day * 5 });
      assert.isTrue(
        (yield* restarted.evaluate({
          ...input,
          nowMs: day * 5,
          plannedCount: 3,
          requiresConfirmation: true,
        })).apply,
      );
    }).pipe(
      Effect.provide(
        Layer.merge(NodeSqliteClient.layer({ filename: ":memory:" }), NodeServices.layer),
      ),
    ),
);
