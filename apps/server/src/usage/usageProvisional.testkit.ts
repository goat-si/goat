// @effect-diagnostics nodeBuiltinImport:off - fixture writes provider transcript files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { UsageDay, type UsageSummary, type UsageSummaryInput } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import { totalOutputTokens } from "./UsageAssertions.testkit.ts";
import * as UsageService from "./UsageService.ts";
import type * as Main from "./UsageService.test.ts";
import { SCAN_CACHE_FILE_NAME } from "./usageScanCache.ts";
import { WINDOW } from "./usageUnpriced.testkit.ts";

const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeUnknownJsonString = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

const BEFORE_NARROW_WINDOW = Date.parse("2026-08-01T10:00:00Z") / 1000;
const NARROW_WINDOW_MTIME = Date.parse("2026-09-01T10:00:00Z") / 1000;
const NARROW_WINDOW: UsageSummaryInput = {
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-09-01"),
  untilDay: UsageDay.make("2026-09-02"),
};

// OmO falls back to PI_CODING_AGENT_DIR, and a directory two providers read is never answered from
// memory; give OmO its own directory, as its default does outside tests.
const ownOmoDir = (home: string) => ({ OMO_CODING_AGENT_DIR: NodePath.join(home, "omo") });

export function registerProvisionalTests(
  setup: typeof Main.setup,
  layerService: typeof Main.layerService,
  claudeLine: typeof Main.claudeLine,
) {
  it.live(
    "answers a provisional read from the last scan, then the exact read adds what changed",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
        const provisional = { ...WINDOW, provisional: true };
        const claude = (summary: UsageSummary) =>
          summary.sources.find((source) => source.fingerprint.provider === "claude");
        yield* Effect.gen(function* () {
          // With nothing persisted, the first answer is a full scan.
          const service = yield* UsageService.make;
          const loop = NodePath.join(NodePath.dirname(transcript), "loop.jsonl");
          yield* Effect.promise(() => NodeFSP.symlink(loop, loop, "junction"));
          assert.strictEqual(claude(yield* service.readSummary(provisional))?.status, "partial");
          yield* Effect.promise(() => NodeFSP.rm(loop));
          // A scan that missed a path covers nothing, so this is a full scan too.
          assert.isUndefined(claude(yield* service.readSummary(provisional))?.refreshing);
          yield* service.awaitPersisted;

          yield* Effect.promise(() => NodeFSP.appendFile(transcript, claudeLine(2, 7)));
          const restarted = yield* UsageService.make;
          const saved = yield* restarted.readSummary(provisional);
          assert.strictEqual(totalOutputTokens(saved), 5);
          assert.isTrue(claude(saved)?.refreshing);
          // A window that starts before the saved scan could only show part of its usage.
          const wider = yield* restarted.readSummary({
            ...provisional,
            sinceDay: UsageDay.make("2026-07-01"),
          });
          assert.strictEqual(totalOutputTokens(wider), 12);
          assert.isUndefined(claude(wider)?.refreshing);
          const refreshed = yield* restarted.readSummary({ ...WINDOW, awaitRefresh: true });
          assert.strictEqual(totalOutputTokens(refreshed), 12);
          assert.isUndefined(claude(refreshed)?.refreshing);
          // Saved usage with nothing to show marks nothing refreshing, so it must not be the answer.
          yield* Effect.promise(() =>
            NodeFSP.appendFile(transcript, claudeLine(3, 11, "claude-other")),
          );
          const unseen = yield* restarted.readSummary({
            ...provisional,
            modelFilter: { include: [{ model: "claude-other" }] },
          });
          assert.strictEqual(totalOutputTokens(unseen), 11);
          yield* restarted.awaitPersisted;

          // A saved scan with an entry this server cannot read covers nothing.
          const { stateDir } = yield* ServerConfig.ServerConfig;
          const cachePath = NodePath.join(stateDir, SCAN_CACHE_FILE_NAME);
          yield* Effect.promise(async () => {
            const document = decodeUnknownJsonString(await NodeFSP.readFile(cachePath, "utf8")) as {
              files: Record<string, Record<string, unknown>>;
            };
            const [entry] = Object.values(document.files);
            document.files[NodePath.join(NodePath.dirname(transcript), "broken.jsonl")] = {
              ...entry,
              r: "broken",
            };
            await NodeFSP.writeFile(cachePath, encodeUnknownJsonString(document));
          });
          const reloaded = yield* UsageService.make;
          assert.isUndefined(claude(yield* reloaded.readSummary(provisional))?.refreshing);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            layerService({
              prefix: "usage-service-provisional",
              home,
              settings,
              environment: ownOmoDir(home),
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live("answers a read without provisional, as older clients send, with an exact scan", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        yield* service.readSummary(WINDOW);
        yield* service.awaitPersisted;
        yield* Effect.promise(() => NodeFSP.appendFile(transcript, claudeLine(2, 7)));
        const restarted = yield* UsageService.make;
        const summary = yield* restarted.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(summary), 12);
        assert.isFalse(summary.sources.some((source) => source.refreshing === true));
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerService({
            prefix: "usage-service-older-client",
            home,
            settings,
            environment: ownOmoDir(home),
          }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("credits the same copy of a duplicate from the last scan as an exact read does", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-08-15T00:00:00Z"));
      const { transcript, settings, home } = yield* setup;
      const dir = NodePath.dirname(transcript);
      const [first = "", second = ""] = yield* Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(dir, "a.jsonl"), "");
        await NodeFSP.writeFile(NodePath.join(dir, "b.jsonl"), "");
        return (await NodeFSP.readdir(dir)).map((name) => NodePath.join(dir, name));
      });
      const forked = (line: string) => line.replace('"session-1"', '"session-2"');
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(first, claudeLine(1, 5));
        await NodeFSP.utimes(first, BEFORE_NARROW_WINDOW, BEFORE_NARROW_WINDOW);
        await NodeFSP.writeFile(second, forked(claudeLine(1, 5)) + forked(claudeLine(2, 7)));
      });
      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        // The narrow window saves the second copy before the wide one reads the first.
        yield* service.readSummary(NARROW_WINDOW);
        const exact = yield* service.readSummary(WINDOW);
        yield* service.awaitPersisted;
        const restarted = yield* UsageService.make;
        const saved = yield* restarted.readSummary({ ...WINDOW, provisional: true });
        assert.isTrue(saved.sources.some((source) => source.refreshing === true));
        assert.deepStrictEqual(saved.buckets, exact.buckets);
      }).pipe(
        Effect.provide(
          layerService({
            prefix: "usage-service-saved-order-test",
            home,
            settings,
            environment: ownOmoDir(home),
          }),
        ),
      );

      // A narrow scan that first saves the earlier copy still puts it before a later file it skipped.
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(first, forked(claudeLine(1, 5)) + forked(claudeLine(2, 7)));
        await NodeFSP.utimes(
          first,
          Date.parse("2026-07-01T00:00:00Z") / 1000,
          Date.parse("2026-07-01T00:00:00Z") / 1000,
        );
        await NodeFSP.writeFile(second, claudeLine(1, 5));
        await NodeFSP.utimes(second, BEFORE_NARROW_WINDOW, BEFORE_NARROW_WINDOW);
      });
      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        yield* service.readSummary(WINDOW);
        yield* Effect.promise(() =>
          NodeFSP.utimes(first, NARROW_WINDOW_MTIME, NARROW_WINDOW_MTIME),
        );
        yield* service.readSummary(NARROW_WINDOW);
        const saved = yield* service.readSummary({ ...WINDOW, provisional: true });
        assert.isTrue(saved.sources.some((source) => source.refreshing === true));
        const exact = yield* service.readSummary(WINDOW);
        assert.deepStrictEqual(saved.buckets, exact.buckets);
      }).pipe(
        Effect.provide(
          layerService({
            prefix: "usage-service-narrow-order-test",
            home,
            settings,
            environment: ownOmoDir(home),
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
}
