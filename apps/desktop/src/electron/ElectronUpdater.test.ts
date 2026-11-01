import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

// electron-updater builds the platform updater the first time autoUpdater is read, and that
// constructor rejects an app version that is not semver. Unpackaged Linux dev reports "0.0".
const updater = vi.hoisted(() => {
  const original = () => undefined;
  return {
    version: "0.1.2",
    original,
    executor: { addTimeOutHandler: original as unknown },
    reads: 0,
  };
});

vi.mock("electron-updater", () => ({
  get autoUpdater() {
    updater.reads += 1;
    if (!/^\d+\.\d+\.\d+/.test(updater.version)) {
      throw new Error(
        "App version is not a valid semver version: " + JSON.stringify(updater.version),
      );
    }
    return { httpExecutor: updater.executor, autoDownload: true };
  },
}));

import * as ElectronUpdater from "./ElectronUpdater.ts";

describe("ElectronUpdater", () => {
  beforeEach(() => {
    updater.version = "0.1.2";
    updater.executor = { addTimeOutHandler: updater.original };
    updater.reads = 0;
  });

  it.effect("starts in an unpackaged dev app whose version electron-updater rejects (#1543)", () =>
    Effect.gen(function* () {
      updater.version = "0.0";
      yield* ElectronUpdater.ElectronUpdater.pipe(Effect.provide(ElectronUpdater.layer));
      assert.equal(updater.reads, 0);
    }),
  );

  it.effect("installs the request deadline before the updater's first use", () =>
    Effect.gen(function* () {
      const service = yield* ElectronUpdater.ElectronUpdater.pipe(
        Effect.provide(ElectronUpdater.layer),
      );
      yield* service.setAutoDownload(false);
      assert.notStrictEqual(updater.executor.addTimeOutHandler, updater.original);
    }),
  );
});
