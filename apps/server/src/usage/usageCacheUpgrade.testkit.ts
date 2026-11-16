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
  it.live.each([4, 5, 6, 7, 8, 10, 11, 12, 13, 14])(
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
              // Fields a v14 server never wrote, so the file is the one it leaves behind.
              delete file.cs.latestCumulativeAtMs;
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
            const { coveredSince: _coveredSince, ...written } = document as typeof document & {
              coveredSince?: unknown;
            };
            const text = encodeUnknownJsonString({ ...written, version });
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
          assert.strictEqual(SCAN_CACHE_FILE_NAME, "usage-scan-cache-v15.json");
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

  it.effect("re-prices Claude 1-hour cache writes a v12 cache saved, then drops the v12 file", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      const model = "claude-opus-4-5-20251101";
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          transcript,
          encodeUnknownJsonString({
            type: "assistant",
            timestamp: "2026-08-01T10:00:00Z",
            sessionId: "session-1",
            message: {
              id: "msg_ttl",
              model,
              usage: {
                input_tokens: 0,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 1_000_000,
                cache_creation: {
                  ephemeral_5m_input_tokens: 400_000,
                  ephemeral_1h_input_tokens: 600_000,
                },
                output_tokens: 0,
              },
            },
          }) + "\n",
        ),
      );
      yield* Effect.gen(function* () {
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const cachePath = NodePath.join(stateDir, SCAN_CACHE_FILE_NAME);
        const first = yield* UsageService.make;
        yield* first.readSummary(WINDOW);
        yield* first.awaitPersisted;
        // A v12 row ends at its rate model: it had no slot for 1-hour cache writes.
        yield* Effect.promise(async () => {
          const document = decodeUnknownJsonString(await NodeFSP.readFile(cachePath, "utf8")) as {
            files: Record<string, { r: unknown[][] }>;
          };
          for (const file of Object.values(document.files)) {
            file.r = file.r.map((row) => row.slice(0, 12));
          }
          await NodeFSP.rm(cachePath);
          await NodeFSP.writeFile(
            NodePath.join(stateDir, "usage-scan-cache-v12.json"),
            encodeUnknownJsonString({ ...document, version: 12 }),
          );
        });

        const upgraded = yield* UsageService.make;
        const summary = yield* upgraded.readSummary(WINDOW);
        // 0.4M x $6.25/M + 0.6M x $10/M
        assert.closeTo(
          summary.buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0),
          8.5,
          1e-9,
        );
        yield* upgraded.awaitPersisted;
        assert.deepStrictEqual(
          (yield* Effect.promise(() => NodeFSP.readdir(stateDir))).filter((name) =>
            name.startsWith("usage-scan-cache"),
          ),
          [SCAN_CACHE_FILE_NAME],
        );
      }).pipe(
        Effect.provide(
          layerService({
            prefix: "usage-service-v12-cache-write-test",
            home,
            settings,
            ratesDocument: {
              [model]: {
                litellm_provider: "anthropic",
                input_cost_per_token: 5e-6,
                output_cost_per_token: 25e-6,
                cache_read_input_token_cost: 5e-7,
                cache_creation_input_token_cost: 6.25e-6,
                cache_creation_input_token_cost_above_1hr: 1e-5,
              },
            },
          }),
        ),
      );
    }).pipe(Effect.scoped),
  );
}
