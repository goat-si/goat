// @effect-diagnostics nodeBuiltinImport:off - fixture writes provider transcript files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import type { UsageSummary } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { totalOutputTokens } from "./UsageAssertions.testkit.ts";
import * as UsageService from "./UsageService.ts";
import type * as Main from "./UsageService.test.ts";
import { SCAN_CACHE_FILE_NAME } from "./usageScanCache.ts";
import { WINDOW } from "./usageUnpriced.testkit.ts";

const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeUnknownJsonString = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

export function registerCodexTierReparseTest(
  setup: typeof Main.setup,
  layerService: typeof Main.layerService,
  seedCodexHistory: typeof Main.seedCodexHistory,
) {
  it.live(
    "keeps resolved Codex tiers when a grown pre-v15 cache entry re-parses without history",
    () =>
      Effect.gen(function* () {
        const { home, settings } = yield* setup;
        const sessions = NodePath.join(home, "codex", "sessions");
        const rolloutPath = NodePath.join(sessions, "tier.jsonl");
        const context = (turn_id: string) => ({
          type: "turn_context",
          payload: { model: "gpt-6-astra", turn_id },
        });
        const usage = (output_tokens: number, total_output_tokens: number) => ({
          type: "event_msg",
          timestamp: "2026-08-01T10:00:00Z",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { input_tokens: 0, output_tokens },
              total_token_usage: { input_tokens: 0, output_tokens: total_output_tokens },
            },
          },
        });
        const lines = (records: readonly unknown[]) =>
          records.map((record) => encodeUnknownJsonString(record)).join("\n") + "\n";
        const verify = (summary: UsageSummary, output: number, cost: number) => {
          assert.strictEqual(totalOutputTokens(summary), output);
          assert.strictEqual(
            summary.buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0),
            cost,
          );
        };
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(sessions, { recursive: true });
          await NodeFSP.writeFile(
            rolloutPath,
            lines([
              { type: "session_meta", payload: { id: "tier-session", model_provider: "openai" } },
              context("ultra-turn"),
              usage(1, 1),
              // An equal request at the same time, from a turn priced at the standard tier.
              context("standard-turn"),
              usage(1, 2),
            ]),
          );
        });
        yield* Effect.gen(function* () {
          const { stateDir } = yield* ServerConfig.ServerConfig;
          yield* seedCodexHistory({
            id: "ultra-turn",
            sessionId: "tier-session",
            options: [{ id: "serviceTier", value: "ultrafast" }],
          });
          yield* seedCodexHistory({ id: "standard-turn", sessionId: "tier-session", options: [] });
          const first = yield* UsageService.make;
          verify(yield* first.readSummary(WINDOW), 2, 7);
          yield* first.awaitPersisted;

          // Downgrade the saved cache to v14, whose clean Codex entries cannot resume.
          yield* Effect.promise(async () => {
            const cachePath = NodePath.join(stateDir, SCAN_CACHE_FILE_NAME);
            const document = decodeUnknownJsonString(await NodeFSP.readFile(cachePath, "utf8"));
            await NodeFSP.rm(cachePath);
            await NodeFSP.writeFile(
              NodePath.join(stateDir, "usage-scan-cache-v14.json"),
              encodeUnknownJsonString({ ...(document as object), version: 14 }),
            );
            await NodeFSP.appendFile(rolloutPath, lines([context("later-turn"), usage(2, 4)]));
          });
          const sql = yield* SqlClient.SqlClient;
          yield* sql`ALTER TABLE orchestration_events RENAME TO unavailable_events`;
          const upgraded = yield* UsageService.make;
          verify(yield* upgraded.readSummary(WINDOW), 4, 9);
          yield* upgraded.awaitPersisted;
          const restarted = yield* UsageService.make;
          verify(yield* restarted.readSummary(WINDOW), 4, 9);
          yield* sql`ALTER TABLE unavailable_events RENAME TO orchestration_events`;
        }).pipe(
          Effect.provide(
            layerService({
              prefix: "usage-reparse-tier",
              home,
              settings,
              ratesDocument: {
                "gpt-6-astra": {
                  input_cost_per_token: 0,
                  output_cost_per_token: 1,
                  input_cost_per_token_ultrafast: 0,
                  output_cost_per_token_ultrafast: 6,
                },
              },
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );
}
