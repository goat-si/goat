import { ChannelGatewayError, type ChannelListChildWorkInput } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as ChannelLedger from "./ChannelLedger.ts";
import type * as ChannelChildWorkStore from "./channelChildWorkStore.ts";

export const listChildWork = Effect.fn("ChannelChildWork.listChildWork")(
  function* (
    ledger: ChannelLedger.ChannelLedger["Service"],
    store: ChannelChildWorkStore.ChannelChildWorkStore["Service"],
    ownerId: string,
    input: ChannelListChildWorkInput,
  ) {
    const groups = yield* Effect.forEach(new Set(input.taskIds), (taskId) =>
      Effect.gen(function* () {
        const stored = yield* ledger.getTask(taskId);
        if (stored === undefined || stored.ownerId !== ownerId) return undefined;
        const recent = yield* store.listRecentForTask(taskId, 20);
        return {
          taskId,
          children: recent.children.filter((child) => child.ownerId === ownerId),
          truncated: recent.truncated,
        };
      }),
    );
    return { groups: groups.filter((group) => group !== undefined) };
  },
  Effect.tapError((cause) => Effect.logWarning("GOAT Bot child work read failed", { cause })),
  Effect.mapError(() => new ChannelGatewayError({ reason: "persistence_failed" })),
);
