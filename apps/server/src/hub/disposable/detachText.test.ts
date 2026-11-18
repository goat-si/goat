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
  "owner_open",
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
                    for (const forced of [true, false])
                      for (const refusal of [
                        "o".repeat(40),
                        "link_operation_open",
                        "link_not_found",
                      ]) {
                        const shown = detachMessage({
                          state,
                          name,
                          linkId: "lnk_0123456789abcdef",
                          detach: {
                            step,
                            attempt: 99,
                            operationId,
                            ...(forced ? { force: true as const } : {}),
                            refusal,
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

it("a linked row whose retirement force stopped and whose host key changed names the person's Force its conflict row offers", () => {
  const shown = detachMessage({
    state: "linked",
    name: "cc-1",
    linkId: "lnk_1",
    detach: {
      step: "revoke",
      attempt: 1,
      operationId: "a.force.1",
      force: true,
      sends: 3,
      stop: "revoke_unsettled",
      outcome: "not_found",
    },
    health: { failures: 0, checkedAtMs: 0 },
    linkKeyMoved: false,
    inPen: true,
    stop: "host_key_changed",
  });
  expect(shown?.message).toContain("another SSH host key");
  expect(shown?.nextAction).toContain("forces the detach");
});

it("a purge that stays unknown tells a person to fix what stopped it before forcing", () => {
  const shown = detachMessage({
    state: "detaching",
    name: "cc-1",
    linkId: "lnk_1",
    detach: {
      step: "revoke",
      attempt: 1,
      operationId: "a.purge.1",
      stop: "revoke_unsettled",
      outcome: "unsettled",
    },
    health: undefined,
    linkKeyMoved: false,
    inPen: true,
    stop: undefined,
  });
  expect(shown?.message).toContain("fixes what stopped it");
  expect(shown?.nextAction).toContain("fixes what stopped it");
});

it("an unfinished removal refused as link_operation_open names that code and offers no plain force, which OpenCodex refuses while another revoke is open", () => {
  const shown = detachMessage({
    state: "detaching",
    name: "cc-1",
    linkId: "lnk_1",
    detach: {
      step: "revoke",
      attempt: 2,
      operationId: "a.force.2",
      force: true,
      stop: "link_retirement_owned",
      outcome: "retirement_owned",
      refusal: "link_operation_open",
    },
    health: undefined,
    linkKeyMoved: false,
    inPen: true,
    stop: undefined,
  });
  expect(shown?.message).toContain("link_operation_open");
  expect(shown?.message).not.toContain("link_retirement_owned");
  expect(shown?.message).not.toContain("--force --yes");
});

it("a resolve owed for GOAT's earlier forced revoke is not called the purge it replaced", () => {
  const shown = detachMessage({
    state: "detaching",
    name: "cc-1",
    linkId: "lnk_1",
    detach: {
      step: "recover",
      attempt: 2,
      operationId: "a.force.2",
      force: true,
      outcome: "resolve_owed",
      supersedes: "a.force.1",
    },
    health: undefined,
    linkKeyMoved: false,
    inPen: true,
    stop: undefined,
  });
  expect(shown?.message).toContain("earlier forced revoke");
  expect(shown?.message).not.toContain("purge it replaced");
});

it("an owner left open whose new id met link_operation_open names that code", () => {
  const shown = detachMessage({
    state: "detaching",
    name: "cc-1",
    linkId: "lnk_1",
    detach: {
      step: "revoke",
      attempt: 2,
      operationId: "a.force.2",
      force: true,
      stop: "link_retirement_owned",
      outcome: "owner_open",
      refusal: "link_operation_open",
      owner: "a.force.1",
    },
    health: undefined,
    linkKeyMoved: false,
    inPen: true,
    stop: undefined,
  });
  expect(shown?.message).toContain("a.force.1");
  expect(shown?.message).toContain("link_operation_open");
});

it("a linked machine that answers again after its retirement met link_operation_open names that code and offers no plain force", () => {
  const shown = detachMessage({
    state: "linked",
    name: "cc-1",
    linkId: "lnk_1",
    detach: {
      step: "revoke",
      attempt: 2,
      operationId: "a.force.2",
      force: true,
      stop: "link_retirement_owned",
      outcome: "not_found",
      refusal: "link_operation_open",
    },
    health: { failures: 0, checkedAtMs: 0 },
    linkKeyMoved: false,
    inPen: true,
    stop: undefined,
  });
  expect(shown?.message).toContain("link_operation_open");
  expect(shown?.message).not.toContain("--force --yes");
});

it("another revoke left open does not claim a plain force is refused too, which OpenCodex lets the receipt's owner pass", () => {
  const shown = detachMessage({
    state: "detaching",
    name: "cc-1",
    linkId: "lnk_1",
    detach: {
      step: "revoke",
      attempt: 2,
      operationId: "a.force.2",
      force: true,
      stop: "link_retirement_owned",
      outcome: "retirement_owned",
      refusal: "link_operation_open",
    },
    health: undefined,
    linkKeyMoved: false,
    inPen: true,
    stop: undefined,
  });
  expect(shown?.message).toContain("link_operation_open");
  expect(shown?.message).not.toContain("plain force");
});

it("a linked machine's retirement stopped on GOAT's own open earlier revoke names that revoke", () => {
  const shown = detachMessage({
    state: "linked",
    name: "cc-1",
    linkId: "lnk_1",
    detach: {
      step: "revoke",
      attempt: 2,
      operationId: "a.force.2",
      force: true,
      stop: "link_retirement_owned",
      outcome: "owner_open",
      refusal: "link_operation_open",
      owner: "a.force.1",
    },
    health: { failures: 3, checkedAtMs: 0 },
    linkKeyMoved: false,
    inPen: true,
    stop: undefined,
  });
  expect(shown?.message).toContain("a.force.1");
});

it("a new id that met link_not_found while GOAT could not read its earlier revoke blames that read, not the new id", () => {
  const shown = detachMessage({
    state: "detaching",
    name: "cc-1",
    linkId: "lnk_1",
    detach: {
      step: "revoke",
      attempt: 2,
      operationId: "a.purge.2",
      stop: "revoke_unsettled",
      outcome: "unreadable",
      refusal: "link_not_found",
      owner: "a.purge.1",
    },
    health: undefined,
    linkKeyMoved: false,
    inPen: true,
    stop: undefined,
  });
  expect(shown?.message).toContain("a.purge.1");
  expect(shown?.message).not.toContain("no readable answer for the revoke a.purge.2");
});
