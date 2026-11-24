import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { makeRegistryRuntimeTemp } from "./registryRuntimeTemp.ts";

it.effect(
  "keeps live Antigravity temp directories while sweeping and removes them when their scope closes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-acp-runtime-test-" });
      const temp = `${root}/acp-registry`;
      const manager = yield* makeRegistryRuntimeTemp(temp, "linux");
      const scope = yield* Scope.make();
      const first = yield* manager({ TMPDIR: "/tmp" }).pipe(Scope.provide(scope));
      const live = first.TMPDIR!;
      yield* fs.makeDirectory(`${temp}/run-99999999-orphan/_MEI123`, { recursive: true });
      const untrackedLive = `${temp}/run-${process.pid}-other`;
      yield* fs.makeDirectory(untrackedLive, { recursive: true });
      const secondManager = yield* makeRegistryRuntimeTemp(temp, "linux");
      expect(yield* fs.exists(live)).toBe(true);
      expect(yield* fs.exists(untrackedLive)).toBe(true);
      expect(yield* fs.exists(`${temp}/run-99999999-orphan`)).toBe(false);
      const second = yield* Effect.scoped(secondManager({}));
      expect(second.TMPDIR).not.toBe(live);
      expect(yield* fs.exists(second.TMPDIR!)).toBe(false);
      yield* Scope.close(scope, Exit.void);
      expect(yield* fs.exists(live)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer))),
);

it.effect("overrides case-insensitive Windows temp aliases for the scoped process", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-acp-windows-temp-" });
    const manager = yield* makeRegistryRuntimeTemp(`${root}/runtime`, "win32");
    const spawn = yield* Effect.scoped(manager({ Temp: "old", tMp: "old", OTHER: "kept" }));
    expect(spawn.TEMP).toBe(spawn.TMP);
    expect(spawn.Temp).toBeUndefined();
    expect(spawn.tMp).toBeUndefined();
    expect(spawn.OTHER).toBe("kept");
    expect(yield* fs.exists(spawn.TEMP!)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
