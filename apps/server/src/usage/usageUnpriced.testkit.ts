// @effect-diagnostics nodeBuiltinImport:off - fixture writes provider transcript files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, UsageDay, type UsageSummaryInput } from "@goat/contracts";
import { mergeUsage } from "@goat/shared/usageMerge";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as UsageService from "./UsageService.ts";
import type * as Main from "./UsageService.test.ts";

const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
export const WINDOW: UsageSummaryInput = {
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-07-31"),
  untilDay: UsageDay.make("2026-08-02"),
};

export function registerUnpricedTest(
  setup: typeof Main.setup,
  layerService: typeof Main.layerService,
) {
  it.live("counts unpriced tokens from the unpriced records of a mixed model", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const message = (id: string, cost: number, input: number, output: number, minute: number) =>
        encodeUnknownJson({
          id,
          sessionID: "session-1",
          role: "assistant",
          modelID: "acme-coder-1",
          providerID: "acme",
          time: { created: Date.parse(`2026-08-01T10:0${minute}:00Z`) },
          cost,
          tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
        });
      const priced = yield* message("msg_priced", 1, 60, 40, 0);
      const unpriced = yield* message("msg_unpriced", 0, 9_000, 900, 1);
      yield* Effect.promise(async () => {
        const directory = NodePath.join(home, "opencode", "storage", "message", "session-1");
        await NodeFSP.mkdir(directory, { recursive: true });
        await NodeFSP.writeFile(NodePath.join(directory, "msg_priced.json"), priced);
        await NodeFSP.writeFile(NodePath.join(directory, "msg_unpriced.json"), unpriced);
      });
      const service = yield* UsageService.make.pipe(
        Effect.provide(layerService({ prefix: "usage-service-unpriced-tokens", home, settings })),
      );
      const summary = yield* service.readSummary(WINDOW);
      const model = mergeUsage(
        [{ environmentId: EnvironmentId.make("local"), label: "local", summary }],
        summary.contractVersion,
      ).models.find((entry) => entry.model === "acme-coder-1");

      assert.strictEqual(model?.costUsd, 1);
      assert.strictEqual(model?.totalTokens, 10_000);
      assert.strictEqual(model?.unpricedTokens, 9_900);
    }).pipe(Effect.scoped),
  );
}
