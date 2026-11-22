import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ChannelBotMembers from "./ChannelBotMembers.ts";
import { botThreadId, makeHarness, owner, setupBot } from "./testkit/ChannelHarness.ts";

describe("member bot proposals", () => {
  it.effect.each(["dismiss", "expire", "other owner"] as const)(
    "%s prevents a proposal from creating a member",
    (action) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const members = yield* ChannelBotMembers.ChannelBotMembers;
        const { proposalId } = yield* members.propose(
          {
            clientRequestId: "offer",
            name: "Reviewer",
            avatar: null,
            purpose: "Reviews changes.",
            instructions: "Check the tests.",
            why: "The team needs a second look.",
          },
          owner,
          "test-agent",
        );
        if (action === "dismiss")
          yield* members.resolveProposal({ proposalId, accept: false }, owner);
        if (action === "expire") yield* TestClock.adjust("7 days");
        const reviewer = action === "other owner" ? { ownerId: "another-owner" } : owner;
        assert.strictEqual(
          (yield* Effect.flip(members.resolveProposal({ proposalId, accept: true }, reviewer)))
            .reason,
          "not_found",
        );
        assert.lengthOf(yield* members.list({}, owner), 1);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("a proposal creates the reviewed bot only after acceptance, once", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      const { proposalId } = yield* members.propose(
        {
          clientRequestId: "offer",
          name: "Reviewer",
          avatar: null,
          purpose: "Reviews changes.",
          instructions: "Check the tests.",
          why: "The team needs a second look.",
        },
        owner,
        "test-agent",
      );
      const records = yield* (yield* ThreadManagement.ThreadManagementService).getThreadRecords(
        botThreadId,
        ["turnItems"],
      );
      assert.isTrue(
        records.turnItems.some(
          (item) =>
            item.type === "notification" &&
            item.botProposal?.proposalId === proposalId &&
            item.botProposal.status === "pending",
        ),
      );
      assert.lengthOf(yield* members.list({}, owner), 1);
      yield* members.resolveProposal({ proposalId, accept: true }, owner);
      yield* members.resolveProposal({ proposalId, accept: true }, owner);
      const bots = yield* members.list({}, owner);
      assert.lengthOf(bots, 2);
      assert.strictEqual(bots[1]?.name, "Reviewer");
      assert.strictEqual(bots[1]?.instructions, "Check the tests.");
    }).pipe(Effect.provide(harness.layer));
  });
});
