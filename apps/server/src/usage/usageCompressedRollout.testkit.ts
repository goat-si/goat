// @effect-diagnostics nodeBuiltinImport:off - fixture writes compressed provider transcripts.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
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
export function registerCompressedRolloutTest(
  setup: typeof Main.setup,
  layerService: typeof Main.layerService,
) {
  it.effect("counts compressed Codex rollouts across refresh, rewrites, and cache restarts", () =>
    Effect.gen(function* () {
      const { home, settings } = yield* setup;
      const sessions = NodePath.join(home, "codex", "sessions");
      const compressedPath = NodePath.join(sessions, "compressed.jsonl.zst");
      const usage = (output_tokens: number, timestamp = "2026-08-01T10:00:00Z") =>
        encodeUnknownJsonString({
          type: "event_msg",
          timestamp,
          payload: {
            type: "token_count",
            info: { last_token_usage: { input_tokens: 10, output_tokens } },
          },
        }) + "\n";
      const rollout = (id: string, output: number) =>
        [
          { type: "session_meta", payload: { id } },
          { type: "turn_context", payload: { model: "gpt-6-astra" } },
        ]
          .map((line) => encodeUnknownJsonString(line))
          .join("\n") +
        "\n" +
        usage(output);
      const compressed = rollout("compressed-session", 23);
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(sessions, { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(sessions, "plain.jsonl"),
          rollout("plain-session", 17),
        );
        await NodeFSP.writeFile(compressedPath, NodeZlib.zstdCompressSync(compressed));
      });
      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        const first = yield* service.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(first), 40);
        assert.strictEqual(
          first.sources.find((source) => source.fingerprint.provider === "codex")?.distinctSessions,
          2,
        );
        assert.deepStrictEqual((yield* service.readSummary(WINDOW)).buckets, first.buckets);
        yield* service.awaitPersisted;
        // The same rollout may remain in a plain file while compression finishes.
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(sessions, "copy.jsonl"), compressed),
        );
        assert.strictEqual(totalOutputTokens(yield* service.readSummary(WINDOW)), 40);
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            compressedPath,
            NodeZlib.zstdCompressSync(compressed + usage(31, "2026-08-01T10:00:05Z")),
          ),
        );
        const rewritten = yield* service.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(rewritten), 71);
        assert.deepStrictEqual((yield* service.readSummary(WINDOW)).buckets, rewritten.buckets);
        yield* service.awaitPersisted;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const cachePath = NodePath.join(stateDir, SCAN_CACHE_FILE_NAME);
        const originalPath = (yield* Effect.promise(() => NodeFSP.realpath(compressedPath))).slice(
          0,
          -4,
        );
        yield* Effect.promise(async () => {
          const document = decodeUnknownJsonString(await NodeFSP.readFile(cachePath, "utf8")) as {
            files: Record<
              string,
              { cs: Record<string, unknown>; r: unknown[]; t: unknown[]; mr: number }
            >;
          };
          const archived = document.files[await NodeFSP.realpath(compressedPath)];
          assert.ok(archived);
          document.files[originalPath] = {
            ...archived,
            r: [],
            t: [],
            mr: 1,
            cs: { ...archived.cs, malformedRecords: 1 },
          };
          await NodeFSP.writeFile(cachePath, encodeUnknownJsonString(document));
        });
        const restarted = yield* UsageService.make;
        const restored = yield* restarted.readSummary(WINDOW);
        assert.deepStrictEqual(restored.buckets, rewritten.buckets);
        assert.strictEqual(
          restored.sources.find((source) => source.fingerprint.provider === "codex")
            ?.malformedRecords,
          0,
        );
        yield* restarted.awaitPersisted;
        yield* Effect.promise(async () => {
          const document = decodeUnknownJsonString(await NodeFSP.readFile(cachePath, "utf8")) as {
            files: Record<string, unknown>;
          };
          assert.strictEqual(document.files[originalPath], undefined);
          await NodeFSP.rm(compressedPath);
        });
        const removed = yield* UsageService.make;
        const retained = yield* removed.readSummary(WINDOW);
        assert.deepStrictEqual(retained.buckets, rewritten.buckets);
        assert.strictEqual(
          retained.sources.find((source) => source.fingerprint.provider === "codex")
            ?.malformedRecords,
          0,
        );
        yield* removed.awaitPersisted;
      }).pipe(
        Effect.scoped,
        Effect.provide(layerService({ prefix: "usage-compressed-codex", home, settings })),
      );
    }).pipe(Effect.scoped),
  );
}
