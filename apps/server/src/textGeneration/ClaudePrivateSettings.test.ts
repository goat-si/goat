import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { listClaudeDiscoveryDirectory } from "../provider/claudeDiscoveryBudget.ts";
import { makeClaudePrivateSettingsSweep } from "./ClaudePrivateSettings.ts";

it.layer(NodeServices.layer)("Claude settings sweep", (it) => {
  it.effect("reaps stale private Claude settings and keeps live launches", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const stale = `${root}/goat-claude-settings-abc123`;
      const dead = `${root}/goat-claude-settings-p2147483647-def456`;
      const live = `${root}/goat-claude-settings-p${process.pid}-ghi789`;
      const fresh = `${root}/goat-claude-settings-p2147483647-jkl012`;
      const unrelated = `${root}/something-else`;
      const now = Date.parse("2026-10-17T06:00:00Z");
      yield* TestClock.setTime(now);
      for (const directory of [stale, dead, live, fresh, unrelated]) {
        yield* fs.makeDirectory(directory);
        yield* fs.writeFileString(`${directory}/settings.json`, "{}");
        const timestamp = directory === fresh ? now / 1000 : 1;
        yield* fs.utimes(directory, timestamp, timestamp);
      }
      const sweep = yield* makeClaudePrivateSettingsSweep(
        yield* Path.Path,
        yield* HostProcess.UserId,
      );
      yield* sweep(root);
      expect(yield* fs.exists(stale)).toBe(false);
      expect(yield* fs.exists(dead)).toBe(false);
      for (const directory of [live, fresh, unrelated]) {
        expect(yield* fs.exists(`${directory}/settings.json`)).toBe(true);
      }
    }),
  );

  it.effect("reaches stale settings beyond the first page without removing live settings", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const live = `goat-claude-settings-p${process.pid}-xyz789`;
      yield* fs.makeDirectory(path.join(root, live));
      yield* fs.utimes(path.join(root, live), 1, 1);
      const names = Array.from(
        { length: 1200 },
        (_, i) => `goat-claude-settings-${i.toString(36).padStart(6, "0")}`,
      );
      yield* Effect.forEach(names, (name) => fs.makeDirectory(path.join(root, name)), {
        concurrency: 8,
        discard: true,
      });
      const firstPage = new Set(yield* listClaudeDiscoveryDirectory(root, 1024));
      const stale = names.filter((name) => !firstPage.has(name)).slice(0, 64);
      assert.lengthOf(stale, 64);
      for (const name of stale) {
        const directory = path.join(root, name);
        yield* fs.writeFileString(path.join(directory, "settings.json"), "{}");
        yield* fs.utimes(directory, 1, 1);
      }
      yield* TestClock.setTime(Date.parse("2026-10-17T06:00:00Z"));
      const sweep = yield* makeClaudePrivateSettingsSweep(path, yield* HostProcess.UserId);
      for (let i = 0; i < 7; i++) {
        yield* sweep(root);
        yield* TestClock.adjust("1 minute");
      }
      assert.isTrue(yield* fs.exists(path.join(root, live)));
      const remaining = yield* Effect.filter(stale, (name) => fs.exists(path.join(root, name)));
      assert.deepEqual(remaining, []);
    }),
  );
});
