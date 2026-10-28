// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- private Node preload and native SQL-ring clock boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import { recentSlowSql } from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import { available, missing } from "./report.ts";
import { seed } from "./serverSeed.ts";

if (!process.send) throw new Error("Benchmark preload requires its parent's private IPC pipe");
const initialization = await new Promise<unknown>((resolve) => process.once("message", resolve));
if (
  typeof initialization !== "object" ||
  initialization === null ||
  !("root" in initialization) ||
  typeof initialization.root !== "string"
)
  throw new Error("Missing generated fixture identity");
const root = await NodeFSP.realpath(initialization.root);
const manifest: unknown = JSON.parse(
  await NodeFSP.readFile(NodePath.join(root, "fixture.json"), "utf8"),
);
if (
  typeof manifest !== "object" ||
  manifest === null ||
  !("threads" in manifest) ||
  typeof manifest.threads !== "number" ||
  !Number.isInteger(manifest.threads) ||
  manifest.threads < 1 ||
  !("root" in manifest) ||
  manifest.root !== root ||
  !("synthetic" in manifest) ||
  manifest.synthetic !== true ||
  process.env.HOME !== NodePath.join(root, "home") ||
  process.env.GOAT_HOME !== NodePath.join(root, "goat")
)
  throw new Error("Fixture identity mismatch");

const seeded = await Effect.runPromise(
  seed({
    dbPath: NodePath.join(root, "goat/userdata/statev2.sqlite"),
    workspace: NodePath.join(root, "workspace"),
    threads: manifest.threads,
  }),
);
process.send({ type: "seeded", seeded });
// This measures the target isolate; an external load process cannot measure its loop directly.
const histogram = NodePerfHooks.monitorEventLoopDelay({ resolution: 10 });
histogram.enable();
let beganAtMs = Date.now();
process.on("message", (message: unknown) => {
  if (message === "begin") {
    beganAtMs = Date.now();
    histogram.reset();
    process.send?.({ type: "begun" });
  } else if (message === "snapshot") {
    const count = histogram.count;
    const loop =
      count === 0
        ? missing("Target histogram collected no samples")
        : available({
            count,
            p50Ms: histogram.percentile(50) / 1e6,
            p95Ms: histogram.percentile(95) / 1e6,
            p99Ms: histogram.percentile(99) / 1e6,
            maxMs: histogram.max / 1e6,
          });
    process.send?.({
      type: "snapshot",
      loop,
      slowSql: available(recentSlowSql(Date.now()).filter((row) => row.completedAtMs >= beganAtMs)),
      rssBytes: process.memoryUsage().rss,
    });
  }
});
