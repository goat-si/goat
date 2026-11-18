// @effect-diagnostics nodeBuiltinImport:off - fixtures write provider session history.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as UsageService from "./UsageService.ts";
import { WINDOW } from "./usageUnpriced.testkit.ts";
import type * as Main from "./UsageService.test.ts";

export function registerRateAliasTests(
  setup: typeof Main.setup,
  layerService: typeof Main.layerService,
) {
  it.effect.each(["pi", "omo"] as const)(
    "prices %s usage mapped onto a model from that provider",
    (provider) =>
      Effect.gen(function* () {
        const { home, settings } = yield* setup;
        const dir = NodePath.join(home, provider, "sessions", "project");
        const message = (id: string, model: string) => ({
          type: "message",
          id,
          timestamp: "2026-08-01T10:00:00Z",
          message: {
            role: "assistant",
            provider: "anthropic",
            model,
            usage: { input: 10, output: 5 },
          },
        });
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(dir, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(dir, "session.jsonl"),
            [
              { type: "session", id: "session" },
              message("released", "actual-model"),
              message("preview", "actual-model-preview"),
            ]
              .map((line) => JSON.stringify(line))
              .join("\n") + "\n",
          );
        });
        const summary = yield* Effect.gen(function* () {
          const service = yield* UsageService.make;
          return yield* service.readSummary(WINDOW);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            layerService({
              prefix: "usage-provider-model-alias",
              environment: { OMO_CODING_AGENT_DIR: NodePath.join(home, "omo") },
              home,
              ratesDocument: {
                "actual-model": { input_cost_per_token: 1, output_cost_per_token: 4 },
              },
              settings: {
                ...settings,
                usageModelAliases: { "anthropic/actual-model-preview": "anthropic/actual-model" },
              },
            }),
          ),
        );
        assert.deepStrictEqual(
          summary.buckets
            .filter((bucket) => bucket.provider === provider)
            .map(({ model, records, unpricedRecords, costUsd, costSource }) => ({
              model,
              records,
              unpricedRecords,
              costUsd,
              costSource,
            })),
          [
            {
              model: "anthropic/actual-model",
              records: 2,
              unpricedRecords: 0,
              costUsd: 60,
              costSource: "modelPriced",
            },
          ],
        );
      }),
  );
}
