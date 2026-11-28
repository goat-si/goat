import { assert, it } from "@effect/vitest";
import { CommandId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { layerTest, shareThread, threadId, writeItem } from "./GuestShareService.testkit.ts";

it.effect("gives the guest a failed edit without the text it tried to write", () =>
  Effect.gen(function* () {
    const { orchestrator, guestShares, credential } = yield* shareThread;
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    const failedEdit = (id: string) =>
      writeItem(id, {
        type: "file_change",
        status: "failed",
        fileName: "src/auth.ts",
        diffStr: "-const token = 1;\n+const token = 2;\n",
      });
    const before = yield* failedEdit("item:failed-before");

    const events = yield* guestShares.stream(session);
    const during = yield* failedEdit("item:failed-during");
    const detail = (yield* guestShares.item(session, before)).item;
    yield* orchestrator.dispatch({
      type: "thread.guest-share.close",
      commandId: CommandId.make("close-after-failed-edit"),
      threadId,
    });
    const received = Array.from(yield* Stream.runCollect(events));
    const changes = received.flatMap((event) => {
      if (event.type !== "thread") return [];
      if (event.item.kind === "snapshot") {
        return [
          ...event.item.projection.turnItems,
          ...event.item.projection.visibleTurnItems.map((row) => row.item),
        ];
      }
      return event.item.kind === "event" && event.item.event.type === "turn-item.updated"
        ? [event.item.event.payload]
        : [];
    });
    const failed = changes.filter((item) => item.type === "file_change");
    assert.includeMembers(
      failed.map((item) => item.id),
      [before, during],
    );
    for (const change of [...failed, detail]) {
      assert.deepInclude(change, { status: "failed", fileName: "src/auth.ts" });
      assert.doesNotHaveAnyKeys(change, ["diffStr", "oldStr", "newStr"]);
    }
  }).pipe(Effect.provide(layerTest)),
);
