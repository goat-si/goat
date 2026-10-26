import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, type FallbackChain, type FleetSettings } from "@goat/contracts";

import { decideNext, failedTail, ordinaryThreadChain, type NextInput } from "./fallbackPolicy.ts";

const codex = ProviderInstanceId.make("codex");
const claudeAgent = ProviderInstanceId.make("claudeAgent");
const steps = [
  { instanceId: codex, model: "anthropic/claude-opus-5-5" },
  { instanceId: codex, model: "anthropic2/claude-opus-5-5" },
  { instanceId: codex, model: "gpt-6.1-sol" },
  { instanceId: claudeAgent, model: "claude-opus-5-5" },
];
const chain: FallbackChain = { steps };
const input = (overrides: Partial<NextInput> = {}): NextInput => ({
  chain,
  current: steps[0]!,
  failure: "usage_limit",
  tried: [],
  unavailable: () => undefined,
  ...overrides,
});

describe("decideNext", () => {
  it("moves a usage limit to the next step as the first hop", () => {
    assert.deepStrictEqual(decideNext(input()), { _tag: "Step", step: steps[1]!, hop: 1 });
  });

  it("skips tried and unavailable steps, then wraps to earlier ones", () => {
    const decision = decideNext(
      input({
        current: steps[2]!,
        tried: [steps[1]!],
        unavailable: (step) =>
          step.instanceId === claudeAgent ? "is at its usage limit" : undefined,
      }),
    );
    assert.deepStrictEqual(decision, { _tag: "Step", step: steps[0]!, hop: 2 });
  });

  it("moves past a route that refuses the model for this account on the unavailable trigger (#1205)", () => {
    const refused = input({
      chain: { steps, on: ["usage_limit", "unavailable"] },
      failure: "permission_error",
    });
    assert.deepStrictEqual(decideNext(refused), { _tag: "Step", step: steps[1]!, hop: 1 });
    assert.deepStrictEqual(decideNext(input({ failure: "permission_error" })), {
      _tag: "Exhausted",
      reason: "permission_error is not one of this chain's triggers",
    });
  });

  it("is exhausted when every other step is cooling down", () => {
    assert.deepStrictEqual(decideNext(input({ unavailable: () => "is cooling down" })), {
      _tag: "Exhausted",
      reason:
        "no step is available (codex/anthropic2/claude-opus-5-5 is cooling down, codex/gpt-6.1-sol is cooling down, claudeAgent/claude-opus-5-5 is cooling down)",
    });
  });

  it("stops at maxHops and for failures outside on (default usage_limit)", () => {
    assert.deepStrictEqual(
      decideNext(input({ chain: { steps, maxHops: 1 }, tried: [steps[1]!] })),
      { _tag: "Exhausted", reason: "used all 1 hops" },
    );
    assert.deepStrictEqual(decideNext(input({ failure: "provider_error" })), {
      _tag: "Exhausted",
      reason: "provider_error is not one of this chain's triggers",
    });
    assert.strictEqual(
      decideNext(input({ chain: { steps, on: ["provider_error"] }, failure: "provider_error" }))
        ._tag,
      "Step",
    );
  });

  it("starts work on an unlisted model from the first step", () => {
    const decision = decideNext(input({ current: { instanceId: codex, model: "other" } }));
    assert.deepStrictEqual(decision, { _tag: "Step", step: steps[0]!, hop: 1 });
  });
});

describe("ordinaryThreadChain", () => {
  const settings: FleetSettings = {
    fallbackChains: {
      goalsOnly: { steps },
      b: { steps: [steps[2]!, steps[3]!], scope: "goals_and_threads" },
      a: { steps, scope: "goals_and_threads" },
    },
    defaultFallbackChain: "b",
  };
  it("needs a chain that opted into threads and lists the model, default first", () => {
    assert.strictEqual(ordinaryThreadChain(settings, steps[2]!)?.id, "b");
    assert.strictEqual(ordinaryThreadChain(settings, steps[0]!)?.id, "a");
    assert.isNull(ordinaryThreadChain({ fallbackChains: { goalsOnly: { steps } } }, steps[0]!));
  });
});

describe("failedTail", () => {
  it("collects the models of failed runs since the last run that did not fail", () => {
    const tail = failedTail([
      { ordinal: 1, status: "failed", startedAt: 1, modelSelection: steps[3]! },
      { ordinal: 2, status: "completed", startedAt: 2, modelSelection: steps[0]! },
      { ordinal: 3, status: "failed", startedAt: 3, modelSelection: steps[0]! },
      { ordinal: 5, status: "queued", startedAt: null, modelSelection: steps[2]! },
      { ordinal: 4, status: "failed", startedAt: 4, modelSelection: steps[1]! },
    ]);
    assert.deepStrictEqual(tail, [steps[1]!, steps[0]!]);
  });
});
