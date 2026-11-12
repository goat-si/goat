import { RuntimeRequestId } from "@goat/contracts";
import { expect, it } from "@effect/vitest";

import { isSnoozed } from "./ThreadSettlementService.ts";
import { DAY_MS, NOW_MS, at, shell } from "./ThreadSettlementService.testFixtures.ts";

it("wakes a thread with an approval handoff asked before the snooze, as the sidebar does", () => {
  const snoozed = { snoozedAt: at(-2 * DAY_MS), snoozedUntil: at(DAY_MS) };
  const asked = { id: RuntimeRequestId.make("handoff"), createdAt: at(-3 * DAY_MS) };
  const approval = shell({
    ...snoozed,
    pendingRuntimeRequest: {
      ...asked,
      kind: "user_input",
      handoff: { kind: "approval", title: "Join the hub" },
    },
  });
  const question = shell({ ...snoozed, pendingRuntimeRequest: { ...asked, kind: "user_input" } });

  expect(isSnoozed(approval, NOW_MS)).toBe(false);
  expect(isSnoozed(question, NOW_MS)).toBe(true);
});
