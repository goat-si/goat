// @effect-diagnostics nodeBuiltinImport:off - fixture writes transcript files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { UsageDay, type UsageSummary } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { totalOutputTokens } from "./UsageAssertions.testkit.ts";
import { WINDOW } from "./usageUnpriced.testkit.ts";
import * as UsageService from "./UsageService.ts";
import type * as Main from "./UsageService.test.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export function registerUsageWindowTests(
  setup: typeof Main.setup,
  layerService: typeof Main.layerService,
  claudeLine: typeof Main.claudeLine,
) {
  it.effect("limits cached transcript work and diagnostics to the requested dates", () =>
    Effect.gen(function* () {
      const { home, settings } = yield* setup;
      const dir = NodePath.join(home, "codex", "sessions");
      const transcript = NodePath.join(dir, "rollout.jsonl");
      const line = (timestamp: string, input: number, total: number) =>
        json({
          type: "event_msg",
          timestamp,
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { input_tokens: input, output_tokens: 1 },
              total_token_usage: { input_tokens: total, output_tokens: total / 10 },
            },
          },
        });
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(dir, { recursive: true });
        await NodeFSP.writeFile(
          transcript,
          [
            json({ type: "turn_context", payload: { model: "gpt-6-astra" } }),
            line("2026-08-01T10:00:00Z", 10, 10),
            line("2026-08-01T11:00:00Z", 10, 40),
          ].join("\n") + "\n",
        );
      });
      yield* Effect.gen(function* () {
        const first = yield* UsageService.make;
        const source = (summary: UsageSummary) => {
          const found = summary.sources.find((s) => s.fingerprint.provider === "codex");
          assert.ok(found);
          return found;
        };
        assert.strictEqual(source(yield* first.readSummary(WINDOW)).malformedRecords, 1);
        const hour = {
          ...WINDOW,
          resolution: "hour" as const,
          sinceTime: "2026-08-01T10:00:00Z",
          untilTime: "2026-08-01T11:00:00Z",
        };
        assert.strictEqual(source(yield* first.readSummary(hour)).malformedRecords, 0);

        yield* first.awaitPersisted;
        const restarted = yield* UsageService.make;
        const nextDay = {
          ...WINDOW,
          sinceDay: UsageDay.make("2026-08-02"),
          untilDay: UsageDay.make("2026-08-02"),
        };
        const outside = source(yield* restarted.readSummary(nextDay));
        assert.strictEqual(outside.malformedRecords, 0);
        assert.strictEqual(outside.scannedFiles, 0);
        assert.strictEqual(outside.message, null);
        yield* Effect.promise(() =>
          NodeFSP.appendFile(transcript, line("2026-08-02T10:00:00Z", 10, 10)),
        );
        const mixed = yield* restarted.readSummary(nextDay);
        assert.strictEqual(totalOutputTokens(mixed), 1);
        assert.strictEqual(source(mixed).malformedRecords, 0);
        yield* restarted.awaitPersisted;
        const saved = yield* UsageService.make;
        assert.strictEqual(source(yield* saved.readSummary(nextDay)).malformedRecords, 0);
        assert.strictEqual(source(yield* saved.readSummary(WINDOW)).malformedRecords, 1);
      }).pipe(Effect.provide(layerService({ prefix: "usage-window-diagnostics", home, settings })));
    }),
  );

  it.effect("leaves a duplicate uncounted when its first copy is before the window", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      const dir = NodePath.dirname(transcript);
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(dir, "a.jsonl"), "");
        await NodeFSP.writeFile(NodePath.join(dir, "b.jsonl"), "");
        const [first = "", second = ""] = (await NodeFSP.readdir(dir)).map((name) =>
          NodePath.join(dir, name),
        );
        const nextDay = (line: string) => line.replace("2026-08-01", "2026-08-02");
        await NodeFSP.writeFile(first, claudeLine(1, 5));
        await NodeFSP.writeFile(second, nextDay(claudeLine(1, 5)) + nextDay(claudeLine(2, 7)));
      });
      yield* Effect.gen(function* () {
        const summary = yield* (yield* UsageService.make).readSummary({
          ...WINDOW,
          sinceDay: UsageDay.make("2026-08-02"),
        });
        assert.strictEqual(totalOutputTokens(summary), 7);
      }).pipe(
        Effect.provide(layerService({ prefix: "usage-service-early-copy-test", home, settings })),
      );
    }),
  );
}
