import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { scope, setup, threadScope, verdict } from "./HubMembership.testkit.ts";

const linkAdds = (calls: ReadonlyArray<string>) =>
  calls.filter((call) => call.includes("link add"));

it.effect(
  "after a successful join the same decisionId is refused, even once the link is gone",
  () =>
    Effect.gen(function* () {
      const hub = yield* setup();
      const asked = yield* hub.membership.join(threadScope, { deviceAlias: "lidge-ts" });
      expect(asked.state).toBe("needs_human");
      yield* hub.answer(asked.decisionId!);
      const joined = yield* hub.membership.join(threadScope, {
        deviceAlias: "lidge-ts",
        decisionId: asked.decisionId!,
      });
      expect(joined.state).toBe("child");
      expect(yield* hub.consumed).toEqual([{ approval_id: asked.decisionId }]);
      hub.unlink("lidge-ts");
      const again = yield* hub.membership
        .join(threadScope, { deviceAlias: "lidge-ts", decisionId: asked.decisionId! })
        .pipe(Effect.flip);
      expect(again.message).toContain("already used");
      expect(linkAdds(hub.calls)).toHaveLength(1);
    }),
);

it.effect("two concurrent joins with one approval add one link", () =>
  Effect.gen(function* () {
    const hub = yield* setup();
    const asked = yield* hub.membership.join(scope, { deviceAlias: "lidge-ts" });
    yield* hub.approve(asked.decisionId!);
    const input = { deviceAlias: "lidge-ts", decisionId: asked.decisionId! };
    const results = yield* Effect.all(
      [hub.membership.join(scope, input), hub.membership.join(scope, input)],
      { concurrency: "unbounded" },
    );
    expect(results.map((result) => result.state)).toEqual(["child", "child"]);
    expect(linkAdds(hub.calls)).toHaveLength(1);
  }),
);

it.effect("an approved leave whose revoke fails keeps the approval for another try", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ profile: "hub-admin", linked: ["box"], revokeFails: true });
    const asked = yield* hub.membership.leave(threadScope, { deviceAlias: "box" });
    expect(asked.state).toBe("needs_human");
    yield* hub.answer(asked.decisionId!);
    const input = { deviceAlias: "box", decisionId: asked.decisionId! };
    expect((yield* hub.membership.leave(threadScope, input)).state).toBe("failed");
    expect((yield* hub.membership.leave(threadScope, input)).state).toBe("failed");
    expect(hub.calls.filter((call) => call.includes("link revoke"))).toHaveLength(2);
    expect(yield* hub.consumed).toEqual([]);
  }),
);

it.effect("a re-link approval does not cover a link that was replaced after it was asked", () =>
  Effect.gen(function* () {
    const hub = yield* setup({
      linked: ["macmini-ts"],
      verdicts: [verdict(["P2"]), verdict(["P2"]), verdict()],
    });
    const asked = yield* hub.membership.repair(threadScope, { deviceAlias: "macmini-ts" });
    expect(asked.state).toBe("needs_human");
    yield* hub.answer(asked.decisionId!);
    hub.replaceLink("macmini-ts", "lnk_aaaaaaaaaaaaaaaa");
    const refused = yield* hub.membership
      .repair(threadScope, { deviceAlias: "macmini-ts", decisionId: asked.decisionId! })
      .pipe(Effect.flip);
    expect(refused.message).toContain("does not cover this change");
    expect(hub.calls.some((call) => call.includes("link revoke"))).toBe(false);
  }),
);

it.effect("an answered inbox approval stops covering its change once it expires", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ addFails: true });
    const asked = yield* hub.membership.join(scope, { deviceAlias: "lidge-ts" });
    yield* hub.approve(asked.decisionId!);
    const input = { deviceAlias: "lidge-ts", decisionId: asked.decisionId! };
    expect((yield* hub.membership.join(scope, input)).state).toBe("failed");
    yield* TestClock.adjust("25 hours");
    const expired = yield* hub.membership.join(scope, input).pipe(Effect.flip);
    expect(expired.message).toContain("expired");
    expect(linkAdds(hub.calls)).toHaveLength(1);
  }),
);
