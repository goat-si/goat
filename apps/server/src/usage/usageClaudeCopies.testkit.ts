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

/** One content-block line of message `msg_1`; Claude Code writes several per message. */
function claudeCopy(usage: Readonly<Record<string, number>>): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-01T10:00:00Z",
    requestId: "req_1",
    sessionId: "session-1",
    message: { id: "msg_1", model: "claude-fable-5", usage },
  })}\n`;
}

// A subagent message: its stream-start copy, then its final copy.
const PARTIAL_USAGE = {
  input_tokens: 2,
  cache_creation_input_tokens: 1097,
  cache_read_input_tokens: 67934,
  output_tokens: 3,
};
const COMPLETE_USAGE = { ...PARTIAL_USAGE, output_tokens: 264 };
const COPY_RATES = {
  "claude-fable-5": {
    input_cost_per_token: 1e-5,
    output_cost_per_token: 5e-5,
    cache_read_input_token_cost: 1e-6,
    cache_creation_input_token_cost: 1.25e-5,
  },
};
const COMPLETE_COST_USD = 2 * 1e-5 + 67934 * 1e-6 + 1097 * 1.25e-5 + 264 * 5e-5;
const COMPLETE_TOTALS = {
  uncachedInputTokens: 2,
  cachedInputTokens: 67934,
  cacheCreationTokens: 1097,
  outputTokens: 264,
  reasoningTokens: 0,
};

// Registered from UsageService.test.ts, which owns the shared usage fixture.
export function registerClaudeCopiesTests(
  setup: typeof Main.setup,
  layerService: typeof Main.layerService,
  claudeLine: typeof Main.claudeLine,
) {
  it.live(
    "merges partial Claude copies through tail replacement, newline completion and restart",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        const partial = claudeCopy(PARTIAL_USAGE);
        const complete = claudeCopy(COMPLETE_USAGE);
        yield* Effect.promise(() => NodeFSP.writeFile(transcript, partial));
        yield* Effect.gen(function* () {
          const first = yield* UsageService.make;
          assert.strictEqual(totalOutputTokens(yield* first.readSummary(WINDOW)), 3);
          yield* first.awaitPersisted;

          yield* Effect.promise(() => NodeFSP.appendFile(transcript, complete.trimEnd()));
          const resumed = yield* UsageService.make;
          const tail = yield* resumed.readSummary(WINDOW);
          assert.deepStrictEqual(tail.buckets[0]?.totals, COMPLETE_TOTALS);
          assert.strictEqual(tail.buckets[0]?.records, 1);
          assert.closeTo(tail.buckets[0]?.costUsd ?? 0, COMPLETE_COST_USD, 1e-12);
          yield* resumed.awaitPersisted;
          const restarted = yield* UsageService.make;
          assert.deepStrictEqual((yield* restarted.readSummary(WINDOW)).buckets, tail.buckets);

          // Grow the file without changing its settled prefix: the old tail must be discarded.
          yield* Effect.promise(() =>
            NodeFSP.writeFile(transcript, partial + claudeLine(2, 7) + claudeLine(3, 5)),
          );
          const replaced = yield* restarted.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(replaced), 3 + 7 + 5);
          assert.strictEqual(replaced.buckets[0]?.records, 3);

          yield* Effect.promise(() => NodeFSP.appendFile(transcript, complete.trimEnd()));
          const grown = yield* restarted.readSummary(WINDOW);
          assert.deepStrictEqual(grown.buckets[0]?.totals, {
            ...COMPLETE_TOTALS,
            uncachedInputTokens: 22,
            outputTokens: 264 + 7 + 5,
          });
          assert.strictEqual(grown.buckets[0]?.records, 3);
          yield* Effect.promise(() => NodeFSP.appendFile(transcript, "\n"));
          assert.deepStrictEqual((yield* restarted.readSummary(WINDOW)).buckets, grown.buckets);
          yield* restarted.awaitPersisted;
          assert.deepStrictEqual(
            (yield* (yield* UsageService.make).readSummary(WINDOW)).buckets,
            grown.buckets,
          );
        }).pipe(
          Effect.provide(
            layerService({
              prefix: "usage-service-copy-lifecycle-test",
              home,
              settings,
              ratesDocument: COPY_RATES,
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "re-parses Claude usage a v11 cache saved from a partial copy, then drops the v11 file",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        yield* Effect.promise(() =>
          NodeFSP.writeFile(transcript, claudeCopy(PARTIAL_USAGE) + claudeCopy(COMPLETE_USAGE)),
        );
        yield* Effect.gen(function* () {
          const { stateDir } = yield* ServerConfig.ServerConfig;
          const cachePath = NodePath.join(stateDir, SCAN_CACHE_FILE_NAME);
          const first = yield* UsageService.make;
          yield* first.readSummary(WINDOW);
          yield* first.awaitPersisted;
          // A v11 server kept the first copy of the key: output 3 for an unchanged transcript.
          yield* Effect.promise(async () => {
            const document = decodeUnknownJsonString(await NodeFSP.readFile(cachePath, "utf8")) as {
              files: Record<string, { r: unknown[][] }>;
            };
            for (const file of Object.values(document.files)) {
              file.r = file.r.map((row) => [...row.slice(0, 6), 3, ...row.slice(7)]);
            }
            await NodeFSP.rm(cachePath);
            await NodeFSP.writeFile(
              NodePath.join(stateDir, "usage-scan-cache-v11.json"),
              encodeUnknownJsonString({ ...document, version: 11 }),
            );
          });

          const upgraded = yield* UsageService.make;
          assert.deepStrictEqual(
            (yield* upgraded.readSummary(WINDOW)).buckets[0]?.totals,
            COMPLETE_TOTALS,
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
              prefix: "usage-service-v11-claude-copies-test",
              home,
              settings,
              ratesDocument: COPY_RATES,
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );
}
