import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as HostResources from "./HostResources.ts";
import {
  diskFromStatfs,
  diskPathForPlatform,
  loadAverageForPlatform,
  readHostCapacityExtras,
} from "./hostCapacity.ts";

const statfsOk = (path: string, calls: Array<string>) => {
  calls.push(path);
  return Promise.resolve({ bsize: 4096n, blocks: 100n, bavail: 40n });
};

it.effect("reads the linux volume of the GOAT home and its load average", () =>
  Effect.gen(function* () {
    const calls: Array<string> = [];
    const extras = yield* readHostCapacityExtras({
      platform: "linux",
      dataDir: "/home/goat/.goat",
      loadavg: [1.5, 1.25, 0.5],
      statfs: (path) => statfsOk(path, calls),
    });
    expect(calls).toEqual(["/home/goat/.goat"]);
    expect(extras).toEqual({
      loadAvg: { oneMinute: 1.5, fiveMinutes: 1.25, fifteenMinutes: 0.5 },
      disk: { path: "/home/goat/.goat", availableBytes: 40 * 4096, totalBytes: 100 * 4096 },
    });
    expect(diskPathForPlatform("linux", "relative/.goat")).toBe("/");
  }),
);

it.effect("reads the macOS home volume and its load average", () =>
  Effect.gen(function* () {
    const calls: Array<string> = [];
    const extras = yield* readHostCapacityExtras({
      platform: "darwin",
      dataDir: "/Users/goat",
      loadavg: [0.2, 0.4, 0.6],
      statfs: (path) => statfsOk(path, calls),
    });
    expect(calls).toEqual(["/Users/goat"]);
    expect(diskPathForPlatform("darwin", "/Users/goat")).toBe("/Users/goat");
    expect(diskPathForPlatform("darwin", "Users/goat")).toBe("/");
    expect(extras.loadAvg).toEqual({ oneMinute: 0.2, fiveMinutes: 0.4, fifteenMinutes: 0.6 });
    expect(extras.disk?.path).toBe("/Users/goat");
  }),
);

it.effect("reads the Windows home drive and omits the load average", () =>
  Effect.gen(function* () {
    const calls: Array<string> = [];
    const extras = yield* readHostCapacityExtras({
      platform: "win32",
      dataDir: "C:/Users/goat",
      loadavg: [0, 0, 0],
      statfs: (path) => statfsOk(path, calls),
    });
    expect(calls).toEqual(["C:\\"]);
    expect(loadAverageForPlatform("win32", [0, 0, 0])).toBeNull();
    expect(extras).toEqual({
      loadAvg: null,
      disk: { path: "C:\\", availableBytes: 40 * 4096, totalBytes: 100 * 4096 },
    });
  }),
);

it.effect("treats a Windows statfs failure as no disk", () =>
  Effect.gen(function* () {
    const extras = yield* readHostCapacityExtras({
      platform: "win32",
      dataDir: "D:\\Users\\goat",
      loadavg: [1, 1, 1],
      statfs: () => Promise.reject(Object.assign(new Error("ENOSYS"), { code: "ENOSYS" })),
    });
    expect(extras).toEqual({ loadAvg: null, disk: null });
  }),
);

it("treats a Windows volume with zero blocks as unavailable", () => {
  expect(diskFromStatfs("win32", "C:\\", { bsize: 4096n, blocks: 0n, bavail: 0n })).toBeNull();
  expect(diskPathForPlatform("win32", "\\\\server\\share")).toBeNull();
});

it.effect("does not call statfs for an unknown platform", () =>
  Effect.gen(function* () {
    let called = false;
    const extras = yield* readHostCapacityExtras({
      platform: "freebsd",
      dataDir: "/home/goat",
      loadavg: [1, 1, 1],
      statfs: () => {
        called = true;
        return Promise.resolve({ bsize: 4096n, blocks: 1n, bavail: 1n });
      },
    });
    expect(called).toBe(false);
    expect(extras).toEqual({ loadAvg: null, disk: null });
  }),
);

it("drops a non-finite load average and an overflowing disk", () => {
  expect(loadAverageForPlatform("linux", [Number.NaN, 1, 1])).toBeNull();
  expect(
    diskFromStatfs("linux", "/", {
      bsize: 4096n,
      blocks: BigInt(Number.MAX_SAFE_INTEGER),
      bavail: 1n,
    }),
  ).toBeNull();
});

it.effect("HostResources publishes load and the disk that holds the GOAT home", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const resources = yield* HostResources.HostResources;
    const pending = yield* Effect.forkChild(resources.read);
    yield* TestClock.adjust("1 second");
    const snapshot = yield* Fiber.join(pending);
    expect(snapshot.cpuCount).toBeGreaterThan(0);
    expect(snapshot.loadAvg?.oneMinute).toEqual(expect.any(Number));
    // Worktrees and GOAT's data fill the volume GOAT's home is on, not necessarily / or the login home.
    expect(snapshot.disk?.path).toBe(config.baseDir);
    expect(snapshot.disk?.totalBytes).toBeGreaterThan(0);
  }).pipe(
    Effect.provide(
      HostResources.layer.pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "host-resources-" })),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
