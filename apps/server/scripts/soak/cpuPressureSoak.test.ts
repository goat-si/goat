// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import { guardChild } from "@goat/shared/errorGuards";
import { describe, expect, it } from "@effect/vitest";

describe("soak Codex fixture", () => {
  it("keeps concurrent threads and turn notifications distinct", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-codex-soak-"));
    const script = NodePath.join(dir, "script.json");
    const log = NodePath.join(dir, "lifecycle.ndjson");
    NodeFS.writeFileSync(script, JSON.stringify({ rootThreadId: "unused", notifications: [] }));
    const fixture = new URL(
      "../../src/provider/testFixtures/codexCollabMockPeer.mjs",
      import.meta.url,
    );
    const child = NodeChildProcess.spawn(process.execPath, [fixture.pathname], {
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        GOAT_CODEX_COLLAB_SCRIPT: script,
        GOAT_CODEX_MOCK_SOAK: "1",
        GOAT_CODEX_MOCK_LATENCIES_MS: "0",
        GOAT_CODEX_MOCK_TURN_MS: "0",
        GOAT_SOAK_PROVIDER_LIFECYCLE_LOG: log,
      },
    });
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    const lines = NodeReadline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const send = (id: number, method: string, params: object) =>
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    try {
      send(10, "initialize", {});
      send(11, "config/read", {});
      const initialized = JSON.parse((await lines.next()).value as string);
      const config = JSON.parse((await lines.next()).value as string);
      expect(initialized.result.userAgent).toBe("codex/0.164.0");
      expect(config.result).toEqual({ config: {}, origins: {} });
      send(1, "thread/start", { cwd: "/tmp" });
      send(2, "thread/start", { cwd: "/tmp" });
      const first = JSON.parse((await lines.next()).value as string);
      const second = JSON.parse((await lines.next()).value as string);
      const ids = [first.result.thread.id, second.result.thread.id];
      expect(new Set(ids).size).toBe(2);
      send(3, "turn/start", { threadId: ids[0], input: [] });
      send(4, "turn/start", { threadId: ids[1], input: [] });
      const messages = [];
      while (messages.filter((message) => message.method === "turn/completed").length < 2) {
        messages.push(JSON.parse((await lines.next()).value as string));
      }
      expect(
        messages
          .filter((message) => message.method === "turn/completed")
          .map((message) => message.params.threadId)
          .sort(),
      ).toEqual(ids.sort());
      expect(
        new Set(
          messages
            .filter((message) => message.id === 3 || message.id === 4)
            .map((message) => message.result.turn.id),
        ).size,
      ).toBe(2);
      expect(NodeFS.statSync(`${log}.codex-turns`).mode & 0o777).toBe(0o600);
      child.stdin.end();
      expect(await exited).toBe(0);
      const events = NodeFS.readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events.map((event) => event.event)).toEqual(["start", "session", "session", "exit"]);
    } finally {
      if (child.exitCode === null) child.kill();
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});

import {
  DetailWriter,
  LogTail,
  Observations,
  counter,
  providerRestarts,
  cpuBusy,
  saturation,
} from "./observations.ts";

describe("soak observations", () => {
  it("measures CPU deltas and refuses unsaturated or incomplete samples", () => {
    const before = [{ user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }];
    const after = [{ user: 90, nice: 0, sys: 0, idle: 10, irq: 0 }];
    expect(cpuBusy(before, after)).toEqual([90]);
    const samples = [
      { at: "1", perCore: [90], busy: 90 },
      { at: "2", perCore: [100], busy: 100 },
    ];
    expect(saturation(samples, []).verified).toBe(true);
    expect(saturation(samples, ["gap"]).verified).toBe(false);
    expect(saturation([{ at: "1", perCore: [79], busy: 79 }], []).verified).toBe(false);
    expect(saturation([], []).verified).toBe(false);
  });
  it("writes detail as separate JSON lines", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-detail-"));
    try {
      const path = NodePath.join(dir, "detail");
      const writer = new DetailWriter(path);
      writer.write({ n: 1 });
      writer.write({ n: 2 });
      writer.close();
      expect(
        NodeFS.readFileSync(path, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([{ n: 1 }, { n: 2 }]);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("tails partial lines once and reports truncation and invalid records", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-tail-"));
    const path = NodePath.join(dir, "events");
    try {
      NodeFS.writeFileSync(path, '{"n":1}\n{"n":');
      const values: unknown[] = [];
      const tail = new LogTail(path, (value) => values.push(value));
      tail.read();
      expect(values).toEqual([{ n: 1 }]);
      expect(tail.hasPartialLine).toBe(true);
      NodeFS.appendFileSync(path, "2}\ninvalid\n");
      tail.read();
      tail.read();
      expect(values).toEqual([{ n: 1 }, { n: 2 }]);
      expect(tail.gaps).toContain("invalid line or consumer failure");
      NodeFS.writeFileSync(path, "{}\n");
      tail.read();
      expect(tail.gaps).toContain("file rotated or truncated");
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deduplicates socket episodes and terminal runs and reports unknown coverage", () => {
    const observations = new Observations();
    observations.recordSocket("one", false);
    observations.recordSocket("one", false);
    observations.recordSocket("teardown", true);
    observations.issueRun("one");
    observations.recordRun("one", "completed");
    observations.recordRun("one", "failed");
    observations.issueRun("pending");
    const report = observations.report(["stream gap"], counter(), counter());
    expect(report.result).toBe("fail");
    expect(report.counters.clientDisconnects).toMatchObject({ observed: 1, value: null });
    expect(report.runs).toMatchObject({ completed: 1, failed: 0, incomplete: 1 });
    expect(new Observations().report(["missing telemetry"], counter(), counter()).result).toBe(
      "inconclusive",
    );
  });
  it("does not let trace telemetry gaps obscure socket coverage", () => {
    const observations = new Observations();
    observations.gap("file rotated or truncated");
    const result = observations.report([], counter(), counter(), []);
    expect(result.counters.clientDisconnects.value).toBe(0);
    expect(result.counters.clientDisconnects.coverage).toBe("complete");
  });

  it("reports turn coverage independently and rejects unobserved or incomplete requests", () => {
    const observations = new Observations();
    observations.requestRun();
    observations.issueRun("run");
    observations.recordRun("run", "completed");
    expect(
      observations.report(["unrelated coverage"], counter(), counter()).counters.turnFailures.value,
    ).toBe(0);
    observations.requestRun();
    expect(observations.report([], counter(), counter()).counters.turnFailures.value).toBeNull();
    observations.issueRun("second");
    expect(observations.report([], counter(), counter()).counters.turnFailures.value).toBeNull();
    observations.recordRun("second", "completed");
    observations.streamGap("stream ended");
    expect(observations.report([], counter(), counter()).counters.turnFailures.value).toBeNull();
  });

  it("ignores probes and deduplicates session replacement, exit, and terminated run", () => {
    const lines = [
      { event: "start" as const, pid: 9, instance: "codex", at: "1" },
      { event: "start" as const, pid: 1, instance: "devReplay", at: "1" },
      { event: "session" as const, pid: 1, instance: "devReplay", at: "1", thread: "native" },
      { event: "exit" as const, pid: 1, instance: "devReplay", at: "2" },
      { event: "start" as const, pid: 2, instance: "devReplay", at: "3" },
      { event: "session" as const, pid: 2, instance: "devReplay", at: "3", thread: "native" },
    ];
    const joined = new Map([["native", "thread"]]);
    const window = { start: "1", end: "4", disappeared: [1] };
    const death = [{ thread: "thread", instance: "devReplay", at: "2" }];
    expect(providerRestarts(lines, joined, [], death, [], window)).toMatchObject({
      counter: { value: 1 },
      probeStarts: 1,
      extraSessions: 1,
      processExitEpisodes: 0,
    });
    expect(providerRestarts(lines, new Map(), [], [], [], window).counter.value).toBeNull();
    expect(providerRestarts(lines.slice(0, 4), joined, [], death, [], window).counter.value).toBe(
      1,
    );
    expect(
      providerRestarts(
        lines.slice(0, 4),
        joined,
        [{ thread: "thread", at: "2", status: "stopped" }],
        [],
        [],
        window,
      ).counter.value,
    ).toBe(1);
  });
  it("counts a missing process and unmatched terminated run independently", () => {
    const lines = [
      { event: "start" as const, pid: 1, instance: "codex", at: "1" },
      { event: "session" as const, pid: 1, instance: "codex", at: "1", thread: "native" },
    ];
    const joined = new Map([["native", "thread"]]);
    const window = { start: "1", end: "4", disappeared: [1] };
    expect(providerRestarts(lines, joined, [], [], [], window).counter.value).toBe(1);
    expect(
      providerRestarts(
        lines,
        joined,
        [],
        [{ thread: "another", instance: "codex", at: "2" }],
        [],
        window,
      ).counter.value,
    ).toBe(2);
  });
  it("caps detail at a complete line and flags truncation", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-detail-limit-"));
    try {
      const path = NodePath.join(dir, "detail");
      const writer = new DetailWriter(path, 8);
      writer.write({ n: 1 });
      writer.write({ n: 2 });
      writer.close();
      expect(writer.truncated).toBe(true);
      expect(NodeFS.readFileSync(path, "utf8")).toBe('{"n":1}\n');
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { cleanupOwned, parseArgs, validateHome, verifyRuntimeState } from "./cpuPressureSoak.ts";

describe("soak input safety", () => {
  it("cleans up only captured children after a spawn error and can be called twice", async () => {
    const start = (command = process.execPath) => {
      let rejectFailure: (error: Error) => void = () => {};
      const failure = new Promise<never>((_, reject) => {
        rejectFailure = reject;
      });
      void failure.catch(() => {});
      const child = guardChild(
        NodeChildProcess.spawn(command, ["-e", "process.stdin.resume()"], {
          stdio: ["pipe", "ignore", "ignore"],
        }),
        rejectFailure,
      );
      const ready = new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          child.once("exit", (code, signal) => resolve({ code, signal }));
          child.once("error", () => resolve({ code: null, signal: null }));
        },
      );
      return { child, ready, exited, failure };
    };
    const first = start();
    const second = start();
    const failed = start(NodePath.join(NodeOS.tmpdir(), `missing-soak-executable-${process.pid}`));
    const failedReady = failed.ready.catch((error: unknown) => error);
    try {
      await Promise.all([first.ready, second.ready]);
      expect(await failedReady).toBeInstanceOf(Error);
      await cleanupOwned([first, failed]);
      await cleanupOwned([first]);
      expect(first.child.signalCode).toBe("SIGTERM");
      expect(second.child.exitCode).toBeNull();
      expect(second.child.signalCode).toBeNull();
    } finally {
      await cleanupOwned([first, second, failed]);
    }
  });
  it("checks the published runtime identity without treating an absent file as another server", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-runtime-"));
    try {
      expect(verifyRuntimeState(dir, 123, 456)).toBe(false);
      NodeFS.writeFileSync(
        NodePath.join(dir, "server-runtime.json"),
        JSON.stringify({ pid: 123, port: 456 }),
      );
      expect(verifyRuntimeState(dir, 123, 456)).toBe(true);
      expect(() => verifyRuntimeState(dir, 999, 456)).toThrow();
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("rejects invalid ports, counts, paths and unknown flags", () => {
    const args = ["--home", "/tmp/home", "--report", "/tmp/report", "--server-port", "3333"];
    expect(parseArgs(args).serverPort).toBe(3333);
    for (const extra of [
      ["--duration-ms", "0"],
      ["--headless-clients", "-1"],
      ["--other", "1"],
      ["--server-port", "2"],
    ]) {
      expect(() => parseArgs([...args, ...extra])).toThrow();
    }
    expect(() =>
      parseArgs(["--home", "relative", "--report", "/tmp/report", "--server-port", "1"]),
    ).toThrow();
  });

  it("refuses homes and databases that escape the checkout through symlinks", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-home-"));
    const checkout = NodePath.join(dir, "checkout");
    const home = NodePath.join(checkout, ".goat");
    try {
      NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(home, "userdata", "statev2.sqlite"), "copy");
      expect(validateHome(home, checkout)).toBe(home);
      expect(() => validateHome(dir, checkout)).toThrow();
      NodeFS.rmSync(NodePath.join(home, "userdata", "statev2.sqlite"));
      NodeFS.symlinkSync(
        NodePath.join(dir, "outside"),
        NodePath.join(home, "userdata", "statev2.sqlite"),
      );
      NodeFS.writeFileSync(NodePath.join(dir, "outside"), "live");
      expect(() => validateHome(home, checkout)).toThrow();
      NodeFS.rmSync(NodePath.join(home, "userdata", "statev2.sqlite"));
      NodeFS.linkSync(
        NodePath.join(dir, "outside"),
        NodePath.join(home, "userdata", "statev2.sqlite"),
      );
      expect(() => validateHome(home, checkout)).toThrow();
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
