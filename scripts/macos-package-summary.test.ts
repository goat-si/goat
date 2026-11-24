// @effect-diagnostics nodeBuiltinImport:off - Reads the workflow as configuration.
import * as NodeFSP from "node:fs/promises";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { fromYaml } from "@goat/shared/schemaYaml";

it.effect(
  "summarizes macOS assets after collection without blocking release or older promotions",
  () =>
    Effect.gen(function* () {
      const raw = yield* Effect.tryPromise(() =>
        NodeFSP.readFile(new URL("../.github/workflows/goat-nightly.yml", import.meta.url), "utf8"),
      );
      const workflow = yield* Schema.decodeEffect(
        fromYaml(
          Schema.Struct({
            jobs: Schema.Struct({
              desktop_mac: Schema.Struct({
                steps: Schema.Array(
                  Schema.Struct({
                    name: Schema.optionalKey(Schema.String),
                    run: Schema.optionalKey(Schema.String),
                    "continue-on-error": Schema.optionalKey(Schema.Boolean),
                  }),
                ),
              }),
            }),
          }),
        ),
      )(raw);
      const steps = workflow.jobs.desktop_mac.steps;
      const collect = steps.findIndex((step) => step.name === "Collect release assets");
      const summary = steps.findIndex((step) => step.name === "Summarize macOS package sizes");
      const stage = steps.findIndex(
        (step) => step.name === "Stage desktop assets and verification reports",
      );
      assert.isAtLeast(collect, 0);
      assert.isAbove(summary, collect);
      assert.isAbove(stage, summary);
      const step = steps[summary]!;
      assert.isTrue(step["continue-on-error"]);
      assert.include(step.run, "if [ -f .github/scripts/macos-package-sizes.py ]");
      assert.include(
        step.run,
        'python3 .github/scripts/macos-package-sizes.py release-publish >> "$GITHUB_STEP_SUMMARY"',
      );
      assert.include(step.run, "::notice::");
    }),
);
