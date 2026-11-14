import { expect, it } from "@effect/vitest";

import { detachMessage } from "./detachText.ts";

const STATES = ["linked", "detaching", "retired", "returned", "purged", "failed"];
const STEPS = ["settle", "revoke", "recover", "done"];
const OUTCOMES = [
  undefined,
  "unreachable",
  "forgotten",
  "elsewhere",
  "unproven",
  "released",
  "alias_linked",
  "child_recover_unsupported",
  "child_residual",
  "child_conflict",
  "host_key_changed",
  "managed_child_missing",
];
const STOPS = [
  undefined,
  "revoke_child_residual",
  "revoke_child_link_mismatch",
  "revoke_child_disconnect_pending",
  "revoke_answered",
  "revoke_expect_link_unsupported",
  "revoke_child_missing",
  "revoke_refused",
  "revoke_unsettled",
  "link_unsettled",
  "link_lost",
  "link_foreign",
  "link_open",
  "tombstone_limit",
];

it("every detach text fits the wire's 500 characters with the longest name and operation id", () => {
  const name = "m".repeat(63);
  const operationId = "a".repeat(64) + ".force.99";
  let seen = 0;
  for (const state of STATES)
    for (const step of STEPS)
      for (const outcome of OUTCOMES)
        for (const stop of STOPS)
          for (const inPen of [true, false])
            for (const recordStop of [undefined, "host_key_changed"])
              for (const elsewhere of [true, false]) {
                const shown = detachMessage({
                  state,
                  name,
                  linkId: "lnk_0123456789abcdef",
                  detach: {
                    step,
                    attempt: 99,
                    operationId,
                    ...(outcome === undefined ? {} : { outcome }),
                    ...(stop === undefined ? {} : { stop }),
                    ...(elsewhere ? { elsewhere: true as const } : {}),
                  },
                  health: { failures: 47, checkedAtMs: 0 },
                  linkKeyMoved: false,
                  inPen,
                  stop: recordStop,
                });
                if (shown === undefined) continue;
                seen += 1;
                expect(shown.message.length).toBeLessThanOrEqual(500);
                expect((shown.nextAction ?? "").length).toBeLessThanOrEqual(300);
              }
  expect(seen).toBeGreaterThan(100);
});
