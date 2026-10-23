import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import type * as ApprovalHandoffs from "./ApprovalHandoffs.ts";
import { instanceId, person, threadId, withApprovals } from "./ApprovalHandoffs.testkit.ts";

const targetPath = "hub.device_join";
const binding = { binding: "goat-hub-binding: join lidge-ts SHA256:key" };

const ask = (approvals: ApprovalHandoffs.ApprovalHandoffs["Service"]) =>
  Effect.gen(function* () {
    return yield* approvals.request({
      threadId,
      providerInstanceId: instanceId,
      targetPath,
      title: "Join lidge-ts to the hub",
      reason: "GOAT has no pinned host key for this alias.",
      location: "Approving links lidge-ts as a Remote Link Child.",
      binding,
      expiresAt: DateTime.add(yield* DateTime.now, { hours: 1 }),
    });
  });

it.effect("a person's approval covers exactly the change it was asked for, until it expires", () =>
  withApprovals(({ approvals, handoffs }) =>
    Effect.gen(function* () {
      const summary = yield* ask(approvals);
      const check = (input: { readonly targetPath?: string; readonly binding?: object }) =>
        approvals
          .verify({
            threadId,
            handoffId: summary.handoffId,
            targetPath: input.targetPath ?? targetPath,
            binding: { ...(input.binding ?? binding) },
          })
          .pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => "approved" }));
      expect(yield* check({})).toContain("still open");
      yield* handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "completed" },
        person,
      );
      expect(yield* check({})).toBe("approved");
      expect(
        yield* check({ binding: { binding: "goat-hub-binding: join lidge-ts SHA256:other" } }),
      ).toContain("does not cover");
      expect(yield* check({ targetPath: "hub.device_leave" })).toContain("does not cover");
      yield* TestClock.adjust("2 hours");
      expect(yield* check({})).toContain("expired");
    }),
  ),
);

it.effect("a declined approval approves nothing", () =>
  withApprovals(({ approvals, handoffs }) =>
    Effect.gen(function* () {
      const summary = yield* ask(approvals);
      yield* handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "declined" },
        person,
      );
      const result = yield* approvals
        .verify({ threadId, handoffId: summary.handoffId, targetPath, binding })
        .pipe(Effect.flip);
      expect(result.message).toContain("was not given");
    }),
  ),
);
