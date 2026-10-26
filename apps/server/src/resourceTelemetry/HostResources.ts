// Effect FileSystem has no statfs. Disk free space comes from libuv.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import type { HostCapacitySnapshot, HostDiskUsage } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import { readHostCapacityExtras } from "./hostCapacity.ts";

export class HostResources extends Context.Service<
  HostResources,
  {
    readonly read: Effect.Effect<HostCapacitySnapshot>;
    /** Free space of the volume holding a folder; null when it cannot be read. */
    readonly diskAt: (folder: string) => Effect.Effect<HostDiskUsage | null>;
  }
>()("goat/resourceTelemetry/HostResources") {}

function readCpu() {
  const cpus = NodeOS.cpus();
  const cpu = cpus.reduce(
    (sum, { times }) => ({
      idle: sum.idle + times.idle,
      total: sum.total + times.user + times.nice + times.sys + times.idle + times.irq,
    }),
    { idle: 0, total: 0 },
  );
  return { ...cpu, count: cpus.length };
}

function darwinAvailableMemory(output: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(output)?.[1];
  const free = /^Pages free:\s+(\d+)\./m.exec(output)?.[1];
  const inactive = /^Pages inactive:\s+(\d+)\./m.exec(output)?.[1];
  const speculative = /^Pages speculative:\s+(\d+)\./m.exec(output)?.[1];
  if (!pageSize || !free || !inactive || !speculative) return null;
  // vm_stat subtracts speculative pages from its printed "Pages free" count.
  // Adding them here counts each reclaimable page once; purgeable pages overlap.
  const available = (Number(free) + Number(inactive) + Number(speculative)) * Number(pageSize);
  return Number.isSafeInteger(available) && Number(pageSize) > 0 ? available : null;
}

const make = Effect.fn("makeHostResources")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const { baseDir } = yield* ServerConfig.ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const sample = Effect.fn("HostResources.sample")(function* () {
    const previousCpu = readCpu();
    // CPU counters need two readings. Load and disk are taken during that
    // interval so a status read does not wait twice. Idle servers do no
    // polling or process scans.
    const [, extras] = yield* Effect.all(
      [
        Effect.sleep("200 millis"),
        readHostCapacityExtras({
          platform,
          dataDir: baseDir,
          loadavg: NodeOS.loadavg(),
          statfs: (path) => NodeFSP.statfs(path, { bigint: true }),
        }),
      ],
      { concurrency: "unbounded" },
    );
    const cpu = readCpu();
    const totalDelta = cpu.total - previousCpu.total;
    const idleDelta = cpu.idle - previousCpu.idle;
    const cpuUtilization =
      previousCpu.count === cpu.count && totalDelta > 0 && idleDelta >= 0
        ? Math.min(1, Math.max(0, 1 - idleDelta / totalDelta))
        : null;
    const totalMemoryBytes = NodeOS.totalmem();
    // On Windows libuv returns GlobalMemoryStatusEx.ullAvailPhys, including standby memory.
    let availableMemoryBytes = NodeOS.freemem();
    if (platform === "linux") {
      const meminfo = yield* fs
        .readFileString("/proc/meminfo")
        .pipe(Effect.orElseSucceed(() => ""));
      const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1];
      if (available) availableMemoryBytes = Number(available) * 1024;
    } else if (platform === "darwin") {
      const output = yield* spawner
        .string(ChildProcess.make("/usr/bin/vm_stat", [], { stdin: "ignore", stderr: "ignore" }))
        .pipe(
          Effect.timeout("1 second"),
          Effect.orElseSucceed(() => ""),
        );
      availableMemoryBytes = darwinAvailableMemory(output) ?? availableMemoryBytes;
    }
    return {
      sampledAt: DateTime.toEpochMillis(yield* DateTime.now),
      cpuUtilization,
      cpuCount: cpu.count,
      availableMemoryBytes: Math.min(totalMemoryBytes, Math.max(0, availableMemoryBytes)),
      totalMemoryBytes,
      loadAvg: extras.loadAvg,
      disk: extras.disk,
    };
  });

  const cache = yield* Cache.make({
    capacity: 1,
    lookup: (_key: "host") => sample(),
    timeToLive: "5 seconds",
  });
  const statfs = (path: string) => NodeFSP.statfs(path, { bigint: true });
  return HostResources.of({
    read: Cache.get(cache, "host"),
    diskAt: (folder) =>
      readHostCapacityExtras({ platform, dataDir: folder, loadavg: [], statfs }).pipe(
        Effect.map((extras) => extras.disk),
      ),
  });
});

export const layer = Layer.effect(HostResources, make());
