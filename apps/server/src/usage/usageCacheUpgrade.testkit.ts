// @effect-diagnostics nodeBuiltinImport:off - fixture writes provider transcript files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { totalOutputTokens } from "./UsageAssertions.testkit.ts";
import * as UsageService from "./UsageService.ts";
import type * as Main from "./UsageService.test.ts";
import { SCAN_CACHE_FILE_NAME } from "./usageScanCache.ts";
import { WINDOW } from "./usageUnpriced.testkit.ts";

const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeUnknownJsonString = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

// Registered from UsageService.test.ts, which owns the shared usage fixture.
export function registerCacheUpgradeTest(
  setup: typeof Main.setup,
  layerService: typeof Main.layerService,
) {
  it.live.each([4, 5, 6, 7, 8, 10])(
    "upgrades a v%s cache: reparses live Codex usage, keeps deleted rollouts, removes the old file",
    (version) =>
      Effect.gen(function* () {
        const { home, settings } = yield* setup;
        const sessions = NodePath.join(home, "codex", "sessions");
        const rollout = (sessionId: string, outputTokens: number) =>
          [
            { type: "session_meta", payload: { id: sessionId } },
            { type: "turn_context", payload: { model: "gpt-6-astra" } },
            {
              type: "event_msg",
              payload: {
                type: "thread_settings_applied",
                thread_settings: { service_tier: "ultrafast" },
              },
            },
            {
              type: "event_msg",
              timestamp: "2026-08-01T10:00:00Z",
              payload: {
                type: "token_count",
                info: {
                  last_token_usage: { input_tokens: 0, output_tokens: outputTokens },
                  total_token_usage: { input_tokens: 100, output_tokens: outputTokens + 30 },
                },
              },
            },
          ]
            .map((line) => encodeUnknownJsonString(line))
            .join("\n") + "\n";
        const live = NodePath.join(sessions, "live.jsonl");
        const deleted = NodePath.join(sessions, "deleted.jsonl");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(sessions, { recursive: true });
          await NodeFSP.writeFile(live, rollout("live", 10));
          await NodeFSP.writeFile(deleted, rollout("deleted", 20));
        });

        yield* Effect.gen(function* () {
          const { stateDir } = yield* ServerConfig.ServerConfig;
          const cachePath = NodePath.join(stateDir, SCAN_CACHE_FILE_NAME);
          const legacyPath = NodePath.join(
            stateDir,
            version === 4 ? "usage-scan-cache.json" : `usage-scan-cache-v${version}.json`,
          );
          const first = yield* UsageService.make;
          yield* first.readSummary(WINDOW);
          yield* first.awaitPersisted;

          yield* Effect.promise(async () => {
            const livePath = await NodeFSP.realpath(live);
            const document = decodeUnknownJsonString(await NodeFSP.readFile(cachePath, "utf8")) as {
              files: Record<string, { r: unknown[][]; mr: number; cs: Record<string, unknown> }>;
            };
            for (const [path, file] of Object.entries(document.files)) {
              file.r = file.r.map((row) => [
                ...row.slice(0, 6),
                path === livePath ? 99 : row[6],
                ...row.slice(7, 10),
                version === 4 ? 0 : 1,
              ]);
              if (version === 4) delete file.cs.speed;
              if (version < 6) {
                delete file.cs.lastCumulativeUsage;
                delete file.cs.malformedRecords;
              }
              if (version >= 8 && path === livePath) {
                file.r = [];
                file.mr = 1;
                file.cs.malformedRecords = 1;
              }
            }
            const text = encodeUnknownJsonString({ ...document, version });
            await NodeFSP.rm(cachePath);
            await NodeFSP.writeFile(legacyPath, text);
            if (version === 6) {
              for (const [name, olderVersion] of [
                ["usage-scan-cache-v5.json", 5],
                ["usage-scan-cache.json", 4],
              ] as const) {
                await NodeFSP.writeFile(
                  NodePath.join(stateDir, name),
                  encodeUnknownJsonString({ ...document, version: olderVersion, files: {} }),
                );
              }
            }
            await NodeFSP.rm(deleted);
            await NodeFSP.mkdir(`${cachePath}.stale`);
            await NodeFSP.utimes(`${cachePath}.stale`, 0, 0);
            await NodeFSP.mkdir(`${cachePath}.active`);
          });

          const upgraded = yield* UsageService.make;
          const summary = yield* upgraded.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(summary), 30);
          assert.strictEqual(
            summary.buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0),
            60 + 20 * (version === 4 ? 1 : 2),
          );
          yield* upgraded.awaitPersisted;
          assert.strictEqual(SCAN_CACHE_FILE_NAME, "usage-scan-cache-v12.json");
          assert.deepStrictEqual(
            (yield* Effect.promise(() => NodeFSP.readdir(stateDir)))
              .filter((name) => name.startsWith("usage-scan-cache"))
              .toSorted(),
            [SCAN_CACHE_FILE_NAME, `${SCAN_CACHE_FILE_NAME}.active`],
          );
        }).pipe(
          Effect.provide(
            layerService({
              prefix: "usage-service-cache-upgrade-test",
              home,
              settings,
              ratesDocument: {
                "gpt-6-astra": {
                  input_cost_per_token: 0,
                  output_cost_per_token: 1,
                  input_cost_per_token_priority: 0,
                  output_cost_per_token_priority: 2,
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
