// @effect-diagnostics nodeBuiltinImport:off -- standalone experiment owns child processes and artifact streams.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as HostProcess from "@goat/shared/HostProcess";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeReadline from "node:readline";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";
import { available, missing, shortTable } from "./bench/report.ts";
import { makeFixture } from "./bench/serverFixture.ts";
import { runLoad } from "./bench/serverLoad.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    threads: { type: "string", default: "32" },
    rounds: { type: "string", default: "20" },
    "output-dir": { type: "string", default: ".goat/bench/responsiveness" },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  process.stdout.write(
    "Usage: node apps/server/scripts/bench-server-responsiveness.ts [--threads 32] [--rounds 20] [--output-dir .goat/bench/responsiveness]\nReport only: creates synthetic temporary state, starts the normal server, writes summary.json, then removes its fixture.\n",
  );
  process.exit(0);
}
const threads = Number(values.threads);
const rounds = Number(values.rounds);
if (
  !Number.isInteger(threads) ||
  threads < 1 ||
  threads > 4096 ||
  !Number.isInteger(rounds) ||
  rounds < 1 ||
  rounds > 4096
)
  throw new Error("threads and rounds must be integers from 1 to 4096");
const output = NodePath.resolve(values["output-dir"]);
await NodeFSP.mkdir(output, { recursive: true });
const Measurement = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("available"),
    value: Schema.Struct({
      count: Schema.Number,
      p50Ms: Schema.Number,
      p95Ms: Schema.Number,
      p99Ms: Schema.Number,
      maxMs: Schema.Number,
    }),
  }),
  Schema.Struct({ status: Schema.Literal("missing"), reason: Schema.String }),
]);
const Snapshot = Schema.Struct({
  type: Schema.Literal("snapshot"),
  loop: Measurement,
  rssBytes: Schema.Number,
  slowSql: Schema.Struct({
    status: Schema.Literal("available"),
    value: Schema.Array(
      Schema.Struct({
        connection: Schema.String,
        operation: Schema.String,
        owner: Schema.String,
        nativeMs: Schema.Number,
        completedAtMs: Schema.Number,
      }),
    ),
  }),
});
const started = NodePerfHooks.performance.now();
let fixture: Awaited<ReturnType<typeof makeFixture>> | undefined;
const report: Record<string, unknown> = {
  schema: "goat.responsiveness-report/1",
  mode: "report-only",
  status: "incomplete",
  source: {
    head: NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      cwd: import.meta.dirname,
    }).trim(),
    dirty:
      NodeChildProcess.execFileSync("git", ["status", "--porcelain"], {
        encoding: "utf8",
        cwd: import.meta.dirname,
      }).trim().length > 0,
  },
  runtime: {
    node: process.version,
    platform: HostProcess.Platform.defaultValue(),
    release: NodeOS.release(),
    cpu: NodeOS.cpus()[0]?.model,
    cpuCount: NodeOS.cpus().length,
  },
  profile: {
    threads,
    rounds,
    concurrency: 4,
    histogramResolutionMs: 10,
    arrivalModel: "bounded closed-loop",
  },
  coverage: {
    turns: "Codex replay during fixture preparation; no live providers",
    workload: "normal bin.ts server, authenticated WS RPC and signed HTTP upload on loopback",
  },
  eventLoop: missing("No target snapshot received"),
  slowSql: missing("No target snapshot received"),
  slowSqlCoverage:
    "Native operations >=50 ms completed during the measured phase; ring retains at most 64 entries for 60 seconds, not a complete query census",
  trace: missing("Trace files not yet collected"),
  traceAccounting: missing(
    "Production considered/suppressed/dropped/rotation counters are not wired to this private runner",
  ),
  deferred: [
    "acceptance budgets",
    "Windows calibration",
    "large generated-state trials",
    "fault recovery",
    "open-loop saturation",
    "remote connection latency",
    "queue census",
  ],
};
let failure: unknown;
try {
  fixture = await makeFixture(threads);
  const seedReceipt = await fixture.ready;
  report.fixture = {
    seedReceipt,
    stateBytes: (await NodeFSP.stat(NodePath.join(fixture.root, "goat/userdata/statev2.sqlite")))
      .size,
  };
  report.preparationAndStartupMs = NodePerfHooks.performance.now() - started;
  await fixture.receipt("begun", "begin");
  const loadStarted = NodePerfHooks.performance.now();
  const load = await runLoad(fixture.origin, fixture.credential, rounds);
  report.workloadMs = NodePerfHooks.performance.now() - loadStarted;
  report.load = load;
  const snapshot = Schema.decodeUnknownSync(Snapshot)(
    await fixture.receipt("snapshot", "snapshot"),
  );
  report.eventLoop = snapshot.loop;
  report.slowSql = snapshot.slowSql;
  report.rssBytes = snapshot.rssBytes;
  report.status = "completed";
  process.stdout.write(
    shortTable([["Target loop (raw 10 ms)", snapshot.loop], ...Object.entries(load.latencies)]) +
      "\n",
  );
} catch (error) {
  failure = error;
  report.error = fixture
    ? String(error).replaceAll(fixture.credential, "[credential]")
    : String(error);
} finally {
  if (fixture) {
    try {
      await fixture.close();
    } catch (error) {
      failure ??= error;
      report.status = "incomplete";
      report.shutdownError = String(error);
    }
    try {
      const files = (await NodeFSP.readdir(fixture.root)).filter((name) =>
        name.startsWith("trace.ndjson"),
      );
      if (files.length === 0) report.trace = missing("Server produced no trace file");
      else {
        let bytes = 0;
        let records = 0;
        for (const file of files) {
          bytes += (await NodeFSP.stat(NodePath.join(fixture.root, file))).size;
          for await (const line of NodeReadline.createInterface({
            input: NodeFS.createReadStream(NodePath.join(fixture.root, file)),
            crlfDelay: Infinity,
          })) {
            if (line.trim()) {
              JSON.parse(line);
              records++;
            }
          }
        }
        report.trace = available({
          bytes,
          records,
          files: files.length,
          window: "server lifetime including startup and shutdown; retained files only",
        });
      }
    } catch (error) {
      report.trace = missing(`Trace collection failed: ${String(error)}`);
    }
  }
  try {
    await NodeFSP.writeFile(
      NodePath.join(output, "summary.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
  } finally {
    await fixture?.remove();
  }
}
process.stdout.write(
  `JSON: ${NodePath.join(output, "summary.json")}\nTrace: ${JSON.stringify(report.trace)}\n`,
);
if (failure) {
  process.stderr.write(String(report.error ?? report.shutdownError) + "\n");
  process.exitCode = 1;
}
