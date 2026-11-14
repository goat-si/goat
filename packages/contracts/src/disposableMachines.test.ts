import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  DISPOSABLE_NAME_RULE_DEFAULT,
  DisposableNameRule,
  HubMachinesError,
  HubMachineStatus,
  matchesDisposableNameRule,
} from "./disposableMachines.ts";

describe("the disposable name rule", () => {
  it("matches whole names by the default rule", () => {
    expect(matchesDisposableNameRule(DISPOSABLE_NAME_RULE_DEFAULT, "cc-04")).toBe(true);
    expect(matchesDisposableNameRule(DISPOSABLE_NAME_RULE_DEFAULT, "a".repeat(31))).toBe(true);
    expect(matchesDisposableNameRule(DISPOSABLE_NAME_RULE_DEFAULT, "a".repeat(32))).toBe(false);
    expect(matchesDisposableNameRule(DISPOSABLE_NAME_RULE_DEFAULT, "4cc")).toBe(false);
    expect(matchesDisposableNameRule(DISPOSABLE_NAME_RULE_DEFAULT, "cc_04")).toBe(false);
    expect(matchesDisposableNameRule("cc-[0-9]+", "cc-12")).toBe(true);
    expect(matchesDisposableNameRule("cc-[0-9]+", "cc-")).toBe(false);
    expect(matchesDisposableNameRule("vm\\.[a-z]{2,3}", "vm.ab")).toBe(true);
    expect(matchesDisposableNameRule("vm\\.[a-z]{2,3}", "vmxab")).toBe(false);
    expect(matchesDisposableNameRule(".*", "x".repeat(64))).toBe(false);
  });

  // A rule that backtracks exponentially in a regex engine is refused, and the matcher stays linear.
  it("refuses groups and alternation, and matches a hostile name at once", () => {
    const valid = Schema.is(DisposableNameRule);
    expect(valid(DISPOSABLE_NAME_RULE_DEFAULT)).toBe(true);
    expect(valid("(a+)+b")).toBe(false);
    expect(valid("a|b")).toBe(false);
    expect(valid("[a-z]{0,99}")).toBe(false);
    const name = "a".repeat(62) + "c";
    expect(matchesDisposableNameRule("a*a*a*a*a*a*a*a*a*a*b", name)).toBe(false);
    expect(matchesDisposableNameRule("(a|a)*b", name)).toBe(false);
  });
});

const decodeStatus = Schema.decodeSync(HubMachineStatus);
const decodeError = Schema.decodeSync(HubMachinesError);

// A newer hub may add a class or a refusal; an older client still reads the rest of the answer.
it("decodes a machine class and a refusal reason this client does not know", () => {
  const status = decodeStatus({
    attachId: "a-1",
    name: "cc-1",
    nodeId: "node",
    state: "retiring",
    step: null,
    steps: [],
    message: "cc-1 is retiring.",
    nextAction: null,
    class: "returned",
    penMember: false,
    provisioner: { kind: "person" },
    stateSince: "2026-11-13T00:00:00.000Z",
  });
  expect(status.class).toBe("returned");
  const error = decodeError({
    _tag: "HubMachinesError",
    reason: "machine_busy",
    detail: "Busy.",
  });
  expect(error.reason).toBe("machine_busy");
});
