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
  "link_retirement_pending",
  "open",
  "not_found",
  "unreadable",
  "unsettled",
  "retirement_owned",
  "resolve_owed",
  "retirement_pending",
];
const STOPS = [
  undefined,
  "revoke_child_residual",
  "revoke_child_link_mismatch",
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
  "link_retirement_owned",
];

it("every detach text fits the wire's 500 characters with the longest name and operation id", () => {
  const name = "m".repeat(63);
  const ids = ["a".repeat(64) + ".force.99", "a".repeat(64) + ".purge.99"];
  let seen = 0;
  for (const operationId of ids)
    for (const state of STATES)
      for (const step of STEPS)
        for (const outcome of OUTCOMES)
          for (const stop of STOPS)
            for (const inPen of [true, false])
              for (const recordStop of [undefined, "host_key_changed"])
                for (const elsewhere of [true, false])
                  for (const failures of [47, 0])
                    for (const forced of [true, false]) {
                      const shown = detachMessage({
                        state,
                        name,
                        linkId: "lnk_0123456789abcdef",
                        detach: {
                          step,
                          attempt: 99,
                          operationId,
                          ...(forced ? { force: true as const } : {}),
                          refusal: "o".repeat(40),
                          foreignLinkId: "lnk_fedcba9876543210",
                          owner: "a".repeat(64) + ".purge.98",
                          supersedes: "a".repeat(64) + ".purge.98",
                          ...(outcome === undefined ? {} : { outcome }),
                          ...(stop === undefined ? {} : { stop }),
                          ...(elsewhere ? { elsewhere: true as const } : {}),
                        },
                        health: { failures, checkedAtMs: 0 },
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

it("an unproven detach names the planted ocx-child by the path a person can run on the machine", () => {
  const shown = detachMessage({
    state: "purged",
    name: "cc-1",
    linkId: null,
    detach: { step: "done", attempt: 1, operationId: "a.link.1", outcome: "unproven" },
    health: undefined,
    linkKeyMoved: false,
    inPen: false,
    stop: undefined,
  });
  expect(shown?.message).toContain("~/.cache/opencodex/bin/ocx-child connect status --json");
  // Resolve refuses an open entry, so the next action does not send a person there for one.
  expect(shown?.nextAction).toContain("an open entry cannot be resolved");
});
