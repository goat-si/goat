import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { makeFixture, modelSelection } from "./AntigravityTextGeneration.testkit.ts";

it.layer(NodeServices.layer)("Antigravity text generation thinking level", (it) => {
  it.effect.each([
    { selected: "low", expected: "low", updates: ["low"], rejected: false },
    { selected: "medium", expected: "high", updates: [], rejected: false },
    { selected: "low", expected: "high", updates: ["low"], rejected: true },
  ])(
    "applies only an advertised saved level, tolerating rejection: $selected $rejected",
    ({ selected, expected, updates, rejected }) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ rejectThinkingUpdate: rejected });
        const result = yield* fixture.textGeneration.generateThreadTitle({
          ...fixture.titleInput,
          modelSelection: {
            ...modelSelection,
            options: [{ id: "thinking_level", value: selected }],
          },
        });
        expect(result).toEqual({ title: "Repair login" });
        expect(fixture.state.thinkingUpdates).toEqual(updates);
        expect(fixture.state.promptThinkingLevels).toEqual([expected]);
        yield* fixture.assertCleaned;
      }),
  );
});
