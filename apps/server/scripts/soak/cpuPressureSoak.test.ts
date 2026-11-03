// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeNet from "node:net";
import * as NodeEvents from "node:events";
import * as NodeSqlite from "node:sqlite";
import { guardChild, guardErrors } from "@goat/shared/errorGuards";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { isSoakExitPrompt } from "../dev-replay-agent.ts";
import {
  codexSocketTransportMode,
  shouldUseCodexSocketTransport,
} from "../../src/provider/CodexDetachedAppServerLive.ts";
import { holdSoakWindow, openRelay } from "./clients.ts";

it("relays bytes and disconnects the owned connection", async () => {
  const server = guardErrors(
    NodeNet.createServer((socket) => {
      guardErrors(socket, () => socket.destroy());
      socket.pipe(socket);
    }),
    () => {},
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test address");
  const relay = await openRelay(`http://127.0.0.1:${address.port}`, 2, () => {});
  const socket = guardErrors(
    NodeNet.connect(Number(new URL(relay.wsBaseUrl).port), "127.0.0.1"),
    () => {},
  );
  const closed = new Promise<void>((resolve) => socket.once("close", resolve));
  try {
    const data = new Promise<string>((resolve) =>
      socket.once("data", (chunk) => resolve(chunk.toString())),
    );
    socket.write("hello");
    expect(await data).toBe("hello");
    relay.disconnectOnly();
    await closed;
  } finally {
    socket.destroy();
    await relay.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("soak Codex fixture", () => {
  it.live("reports unknown Codex methods in the soak result (#2468)", () =>
    Effect.promise(async () => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-codex-unknown-"));
      const script = NodePath.join(dir, "script.json");
      const log = NodePath.join(dir, "lifecycle");
      NodeFS.writeFileSync(script, JSON.stringify({ rootThreadId: "unused", notifications: [] }));
      const fixture = new URL(
        "../../src/provider/testFixtures/codexCollabMockPeer.mjs",
        import.meta.url,
      );
      const child = guardChild(
        NodeChildProcess.spawn(process.execPath, [fixture.pathname], {
          stdio: ["pipe", "pipe", "ignore"],
          env: {
            ...process.env,
            GOAT_CODEX_COLLAB_SCRIPT: script,
            GOAT_CODEX_MOCK_SOAK: "1",
            GOAT_SOAK_PROVIDER_LIFECYCLE_LOG: log,
          },
        }),
        () => {},
      );
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      const lines = NodeReadline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
      try {
        child.stdin.write(`${JSON.stringify({ id: 1, method: "future/method" })}\n`);
        child.stdin.write(`${JSON.stringify({ id: 2, method: "future/method" })}\n`);
        expect(JSON.parse((await lines.next()).value as string).error.code).toBe(-32601);
        expect(JSON.parse((await lines.next()).value as string).error.code).toBe(-32601);
        child.stdin.end();
        expect(await exited).toBe(0);
        const observations = new Observations();
        for (const line of NodeFS.readFileSync(log, "utf8").trim().split("\n"))
          observations.consumeLifecycle(JSON.parse(line));
        expect(observations.report([], counter(), counter()).counters).toMatchObject({
          unknownCodexMethods: { observed: 2 },
        });
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await exited;
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it("forces one Codex exit then completes a recovery turn containing old history", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-codex-recover-"));
    const script = NodePath.join(dir, "script.json");
    NodeFS.writeFileSync(script, JSON.stringify({ rootThreadId: "unused", notifications: [] }));
    const fixture = new URL(
      "../../src/provider/testFixtures/codexCollabMockPeer.mjs",
      import.meta.url,
    );
    const start = () => {
      const child = guardChild(
        NodeChildProcess.spawn(process.execPath, [fixture.pathname], {
          stdio: ["pipe", "pipe", "ignore"],
          env: {
            ...process.env,
            GOAT_CODEX_COLLAB_SCRIPT: script,
            GOAT_CODEX_MOCK_SOAK: "1",
            GOAT_CODEX_MOCK_TURN_MS: "0",
            GOAT_CODEX_MOCK_LATENCIES_MS: "0",
            GOAT_SOAK_PROVIDER_LIFECYCLE_LOG: NodePath.join(dir, "life"),
            GOAT_SOAK_EXIT_ONCE_FILE: NodePath.join(dir, "once"),
          },
        }),
        () => {},
      );
      return {
        child,
        exited: new Promise<number | null>((resolve) => child.once("exit", resolve)),
        lines: NodeReadline.createInterface({ input: child.stdout })[Symbol.asyncIterator](),
      };
    };
    const first = start();
    let second: ReturnType<typeof start> | undefined;
    try {
      first.child.stdin?.write(
        `${JSON.stringify({ id: 1, method: "thread/start", params: { cwd: "/tmp" } })}\n`,
      );
      const response = JSON.parse((await first.lines.next()).value as string);
      const threadId = response.result.thread.id;
      first.child.stdin?.write(
        `${JSON.stringify({ id: 2, method: "turn/start", params: { threadId, input: [{ text: "GOAT_SOAK_EXIT" }] } })}\n`,
      );
      expect(await first.exited).toBe(1);
      second = start();
      second.child.stdin?.write(
        `${JSON.stringify({ id: 1, method: "thread/resume", params: { threadId, cwd: "/tmp" } })}\n`,
      );
      await second.lines.next();
      second.child.stdin?.write(
        `${JSON.stringify({ id: 2, method: "turn/start", params: { threadId, input: [{ text: "old GOAT_SOAK_EXIT; Recovery turn" }] } })}\n`,
      );
      for (;;) {
        const line = await second.lines.next();
        if (line.done) throw new Error("replacement exited before turn completed");
        if (JSON.parse(line.value).method === "turn/completed") break;
      }
      second.child.stdin?.end();
      expect(await second.exited).toBe(0);
    } finally {
      for (const owned of [first, second])
        if (owned) {
          if (owned.child.exitCode === null && owned.child.signalCode === null) owned.child.kill();
          await owned.exited;
        }
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("exits a Codex process for an embedded self-check marker", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-codex-marker-"));
    const script = NodePath.join(dir, "script.json");
    const log = NodePath.join(dir, "lifecycle.ndjson");
    NodeFS.writeFileSync(script, JSON.stringify({ rootThreadId: "unused", notifications: [] }));
    const fixture = new URL(
      "../../src/provider/testFixtures/codexCollabMockPeer.mjs",
      import.meta.url,
    );
    const child = guardChild(
      NodeChildProcess.spawn(process.execPath, [fixture.pathname], {
        stdio: ["pipe", "pipe", "ignore"],
        env: {
          ...process.env,
          GOAT_CODEX_COLLAB_SCRIPT: script,
          GOAT_CODEX_MOCK_SOAK: "1",
          GOAT_SOAK_PROVIDER_LIFECYCLE_LOG: log,
        },
      }),
      () => {},
    );
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    const lines = NodeReadline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    try {
      child.stdin?.write(
        `${JSON.stringify({ id: 1, method: "thread/start", params: { cwd: "/tmp" } })}\n`,
      );
      const result = JSON.parse((await lines.next()).value as string);
      child.stdin?.write(
        `${JSON.stringify({ id: 2, method: "turn/start", params: { threadId: result.result.thread.id, input: [{ text: "prefix GOAT_SOAK_EXIT suffix" }] } })}\n`,
      );
      expect(await exited).toBe(1);
      expect(NodeFS.readFileSync(log, "utf8")).toContain('"event":"exit"');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("recognizes the self-check marker embedded in a Replay prompt", () => {
    expect(isSoakExitPrompt([{ type: "text", text: "user request: GOAT_SOAK_EXIT" }])).toBe(true);
    expect(isSoakExitPrompt([{ type: "text", text: "ordinary prompt" }])).toBe(false);
  });
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
  codexEvidence,
  linuxMemoryPressure,
  providerCoverageGaps,
} from "./observations.ts";

describe("soak observations", () => {
  it.effect(
    "opens the window only after the load starts and reports at least the requested duration",
    () =>
      Effect.gen(function* () {
        const loadStarted = yield* Deferred.make<void>();
        const opened = yield* Deferred.make<number>();
        const closed = yield* Deferred.make<number>();
        const fiber = yield* holdSoakWindow({
          durationMs: 1000,
          startLoad: Deferred.await(loadStarted),
          onWindowStart: (startedAtMs) => Deferred.succeed(opened, startedAtMs).pipe(Effect.asVoid),
          onWindowEnd: (endedAtMs) => Deferred.succeed(closed, endedAtMs).pipe(Effect.asVoid),
        }).pipe(Effect.forkChild);
        yield* TestClock.adjust("50 millis");
        yield* Deferred.succeed(loadStarted, undefined);
        const startedAtMs = yield* Deferred.await(opened);
        expect(startedAtMs).toBe(50);
        yield* TestClock.adjust("999 millis");
        expect(yield* Deferred.isDone(closed)).toBe(false);
        yield* TestClock.adjust("2 millis");
        yield* Fiber.join(fiber);
        const endedAtMs = yield* Deferred.await(closed);
        expect(endedAtMs - startedAtMs).toBeGreaterThanOrEqual(1000);
      }),
  );

  it("classifies Linux memory pressure and rejects missing data", () => {
    expect(linuxMemoryPressure("some avg10=0.00 avg60=0\nfull avg10=0.00 avg60=0\n")).toBe(1);
    expect(linuxMemoryPressure("some avg10=10.00 avg60=0\nfull avg10=0.00 avg60=0\n")).toBe(2);
    expect(linuxMemoryPressure("some avg10=1.00 avg60=0\nfull avg10=0.01 avg60=0\n")).toBe(4);
    expect(() => linuxMemoryPressure("some avg10=0.00\n")).toThrow();
  });
  it("requires observed delayed Codex start and long completion", () => {
    const lines = [
      { event: "scheduled", threadId: "one", turnId: "turn", at: "2026-01-01T00:00:00.000Z" },
      { event: "started", threadId: "one", turnId: "turn", at: "2026-01-01T00:00:30.000Z" },
      { event: "completed", threadId: "one", turnId: "turn", at: "2026-01-01T00:01:31.000Z" },
    ];
    const data = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
    const window = { start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T00:02:00.000Z" };
    expect(codexEvidence(data, [], window)).toMatchObject({
      delayedStarts: 1,
      longCompletedTurns: 1,
      errors: [],
    });
    expect(codexEvidence(data, ["one"], window).delayedStarts).toBe(0);
    expect(codexEvidence(data + "{", [], window).errors).not.toEqual([]);
    expect(
      codexEvidence(data, [], { start: "2026-01-01T00:00:01.000Z", end: window.end }).delayedStarts,
    ).toBe(0);
    expect(
      codexEvidence(data, [], { start: "2026-01-01T00:00:01.000Z", end: window.end })
        .longCompletedTurns,
    ).toBe(0);
    expect(
      codexEvidence(data, [], { start: window.start, end: "2026-01-01T00:01:00.000Z" })
        .longCompletedTurns,
    ).toBe(0);
  });
  it("does not let a stopped release erase a later provider exit or excuse multiple replacements", () => {
    const lines = [
      { event: "start" as const, pid: 1, instance: "devReplay", at: "1" },
      { event: "session" as const, pid: 1, instance: "devReplay", at: "1", thread: "native" },
      { event: "start" as const, pid: 2, instance: "devReplay", at: "4" },
      { event: "session" as const, pid: 2, instance: "devReplay", at: "4", thread: "native" },
      { event: "start" as const, pid: 3, instance: "devReplay", at: "5" },
      { event: "session" as const, pid: 3, instance: "devReplay", at: "5", thread: "native" },
    ];
    const joined = new Map([["native", "thread"]]);
    const release = [{ thread: "thread", at: "2", status: "stopped" as const }];
    const death = [{ thread: "thread", instance: "devReplay", at: "3" }];
    const window = { start: "1", end: "6", disappeared: [] };
    expect(
      providerRestarts(lines.slice(0, 4), joined, release, death, [], window).counter.value,
    ).toBe(1);
    expect(providerRestarts(lines, joined, release, [], [], window).counter.value).toBe(1);
  });
  it("requires a joined session-bearing process for every Replay thread and Codex instance", () => {
    const lines = [
      { event: "start" as const, pid: 1, instance: "devReplay", at: "1" },
      { event: "session" as const, pid: 1, instance: "devReplay", at: "1", thread: "native-a" },
      { event: "start" as const, pid: 2, instance: "codex", at: "1" },
      { event: "session" as const, pid: 2, instance: "codex", at: "1", thread: "native-c" },
    ];
    const joins = new Map([
      ["native-a", "A"],
      ["native-c", "C"],
    ]);
    expect(providerCoverageGaps(lines, joins, ["A", "B"], ["codex"])).toContain(
      "Replay thread B has no joined session-bearing pid",
    );
    expect(providerCoverageGaps(lines, joins, ["A"], ["other"])).toContain(
      "Codex instance other has no joined session-bearing pid",
    );
    expect(providerCoverageGaps(lines, new Map([["native-a", "A"]]), ["A"], ["codex"])).toContain(
      "Codex instance codex has no joined session-bearing pid",
    );
    expect(providerCoverageGaps(lines, joins, ["A"], ["codex"])).toEqual([]);
    expect(providerCoverageGaps(lines.slice(1), joins, ["A"], ["codex"])).toContain(
      "Replay thread A has no joined session-bearing pid",
    );
    const observations = new Observations();
    observations.registerProviderCohort("A", "devReplay");
    observations.registerProviderCohort("B", "devReplay");
    observations.registerProviderCohort("C", "codex");
    expect(
      providerCoverageGaps(
        lines,
        joins,
        [...observations.replayThreads],
        [...observations.codexInstances],
      ),
    ).toEqual(["Replay thread B has no joined session-bearing pid"]);
  });
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
    expect(result.stall.coverage).toBe("unknown");
  });
  it("marks stall coverage unknown after a stall log gap", () => {
    const observations = new Observations();
    observations.consumeStall({ phase: "startup", delayMaxMs: 1, droppedStallRecords: 0 });
    expect(observations.report([], counter(), counter()).stall.coverage).toBe("complete");
    expect(observations.report([], counter(), counter()).stall).toMatchObject({
      runtimeMaxMs: null,
      belowThresholdMs: 2000,
    });
    expect(observations.report([], counter(), counter()).result).toBe("pass");
    observations.stallGap("stall log: file rotated or truncated");
    const report = observations.report([], counter(), counter(), []);
    expect(report.stall.coverage).toBe("unknown");
    expect(report.result).toBe("pass");
    expect(report.counters.clientDisconnects.value).toBe(0);
    observations.consumeStall({ phase: "runtime", delayMaxMs: 2000, droppedStallRecords: 1 });
    expect(observations.report([], counter(), counter(), []).result).toBe("pass");
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
        death,
        [],
        window,
      ).counter.value,
    ).toBe(1);
  });
  it("counts a shared Codex process death only once across affected threads", () => {
    const lines = [
      { event: "start" as const, pid: 1, instance: "codex", at: "1" },
      { event: "session" as const, pid: 1, instance: "codex", at: "1", thread: "a" },
      { event: "session" as const, pid: 1, instance: "codex", at: "1", thread: "b" },
      { event: "exit" as const, pid: 1, instance: "codex", at: "2" },
      { event: "start" as const, pid: 2, instance: "codex", at: "3" },
      { event: "session" as const, pid: 2, instance: "codex", at: "3", thread: "a" },
      { event: "session" as const, pid: 2, instance: "codex", at: "3", thread: "b" },
    ];
    const joined = new Map([
      ["a", "A"],
      ["b", "B"],
    ]);
    const deaths = [
      { thread: "A", instance: "codex", at: "2" },
      { thread: "B", instance: "codex", at: "2" },
    ];
    expect(
      providerRestarts(lines, joined, [], deaths, [], { start: "1", end: "4", disappeared: [] })
        .counter.value,
    ).toBe(1);
    expect(
      providerRestarts(lines.slice(0, 4), joined, [], deaths, [], {
        start: "1",
        end: "4",
        disappeared: [],
      }).counter.value,
    ).toBe(1);
    expect(
      providerRestarts(lines.slice(0, 6), joined, [], deaths, [], {
        start: "1",
        end: "4",
        disappeared: [],
      }).counter.value,
    ).toBe(1);
  });
  it("marks stopped session releases requested but leaves errors unexpected", () => {
    const observations = new Observations();
    observations.releaseProvider("thread", "2", "stopped");
    observations.releaseProvider("thread", "3", "error");
    expect(observations.releases).toMatchObject([{ requested: true }, { requested: false }]);
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
  it("excludes only exits directly following stopped releases of the same sessions", () => {
    const base = [
      { event: "start" as const, pid: 1, instance: "devReplay", at: "1" },
      { event: "session" as const, pid: 1, instance: "devReplay", at: "1", thread: "native" },
      { event: "exit" as const, pid: 1, instance: "devReplay", at: "4" },
    ];
    const joins = new Map([["native", "thread"]]);
    const window = { start: "1", end: "6", disappeared: [] };
    const stopped = [{ thread: "thread", at: "2", status: "stopped" as const }];
    expect(providerRestarts(base, joins, stopped, [], [], window).counter.value).toBe(0);
    expect(providerRestarts(base, joins, [], [], [], window).counter.value).toBe(1);
    expect(
      providerRestarts(
        base,
        joins,
        [{ thread: "thread", at: "5", status: "stopped" }],
        [],
        [],
        window,
      ).counter.value,
    ).toBe(1);
    expect(
      providerRestarts(
        base,
        joins,
        [{ thread: "thread", at: "2", status: "error" }],
        [],
        [],
        window,
      ).counter.value,
    ).toBe(1);
    const resumed = [
      ...base,
      { event: "session" as const, pid: 1, instance: "devReplay", at: "3", thread: "native" },
    ];
    expect(providerRestarts(resumed, joins, stopped, [], [], window).counter.value).toBe(1);
    const replaced = [
      ...base,
      { event: "start" as const, pid: 2, instance: "devReplay", at: "3" },
      { event: "session" as const, pid: 2, instance: "devReplay", at: "3", thread: "native" },
    ];
    expect(providerRestarts(replaced, joins, stopped, [], [], window).counter.value).toBe(1);
    expect(
      providerRestarts(base.slice(0, 2), joins, stopped, [], [], { ...window, disappeared: [1] })
        .counter.value,
    ).toBe(1);
    expect(
      providerRestarts(
        base,
        joins,
        stopped,
        [{ thread: "thread", instance: "devReplay", at: "3" }],
        [],
        window,
      ).counter.value,
    ).toBe(1);
  });
  it("requires all sessions on a shared process to be stopped before excusing its exit", () => {
    const lines = [
      { event: "start" as const, pid: 1, instance: "codex", at: "1" },
      { event: "session" as const, pid: 1, instance: "codex", at: "1", thread: "a" },
      { event: "session" as const, pid: 1, instance: "codex", at: "1", thread: "b" },
      { event: "exit" as const, pid: 1, instance: "codex", at: "4" },
    ];
    const joins = new Map([
      ["a", "A"],
      ["b", "B"],
    ]);
    const window = { start: "1", end: "5", disappeared: [] };
    const first = { thread: "A", at: "2", status: "stopped" as const };
    const second = { thread: "B", at: "3", status: "stopped" as const };
    expect(providerRestarts(lines, joins, [first], [], [], window).counter.value).toBe(1);
    expect(providerRestarts(lines, joins, [first, second], [], [], window).counter.value).toBe(0);
  });
  it("deduplicates sessions per PID and excludes events outside the window and requested releases", () => {
    const lines = [
      { event: "start" as const, pid: 1, instance: "devReplay", at: "1" },
      { event: "session" as const, pid: 1, instance: "devReplay", at: "1", thread: "native" },
      { event: "session" as const, pid: 1, instance: "devReplay", at: "2", thread: "native" },
      { event: "exit" as const, pid: 1, instance: "devReplay", at: "3" },
      { event: "start" as const, pid: 2, instance: "devReplay", at: "4" },
      { event: "session" as const, pid: 2, instance: "devReplay", at: "4", thread: "native" },
    ];
    const joined = new Map([["native", "thread"]]);
    expect(
      providerRestarts(lines, joined, [], [], [], { start: "5", end: "6", disappeared: [] }).counter
        .value,
    ).toBe(0);
    expect(
      providerRestarts(lines.slice(0, 3), joined, [], [], [], {
        start: "1",
        end: "6",
        disappeared: [],
      }).counter.value,
    ).toBe(0);
    expect(
      providerRestarts(
        lines,
        joined,
        [{ thread: "thread", at: "2.5", status: "stopped", requested: true }],
        [],
        [],
        { start: "1", end: "6", disappeared: [] },
      ).counter.value,
    ).toBe(0);
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

import {
  cleanupOwned,
  installSignalHandlers,
  parseArgs,
  validateHome,
  verifyRuntimeState,
} from "./cpuPressureSoak.ts";

describe("soak input safety", () => {
  it("allows only the server's required environment (#2468)", async () => {
    const soak = await import("./cpuPressureSoak.ts");
    const env = soak.serverEnvironment(
      {
        PATH: "/bin",
        HOME: "/home/example",
        LANG: "en_US.UTF-8",
        SECRET_TOKEN: "secret",
        VITE_WS_URL: "bad",
        GOAT_CODEX_APP_SERVER_TRANSPORT: "socket",
      },
      "/tmp/lifecycle",
      "credential",
    );
    expect(env).toMatchObject({
      PATH: "/bin",
      HOME: "/home/example",
      LANG: "en_US.UTF-8",
      GOAT_DEV_AUTH_TOKEN: "credential",
      GOAT_SOAK_PROVIDER_LIFECYCLE_LOG: "/tmp/lifecycle",
      GOAT_CODEX_APP_SERVER_TRANSPORT: "stdio",
    });
    for (const survival of ["off", "restart", "always"] as const)
      expect(shouldUseCodexSocketTransport(codexSocketTransportMode("linux", env), survival)).toBe(
        false,
      );
    expect(env).not.toHaveProperty("SECRET_TOKEN");
    expect(env).not.toHaveProperty("VITE_WS_URL");
  });
  it.live("starts the server directly on Windows without a watchdog", () =>
    Effect.promise(async () => {
      const { spawnWatchedServer } = await import("./cpuPressureSoak.ts");
      const owned = await spawnWatchedServer(
        process.execPath,
        ["-e", "process.stdin.resume()"],
        {
          stdio: ["pipe", "pipe", "pipe"],
        },
        "ignore",
        "win32",
      );
      try {
        expect(owned.server.child.spawnfile).toBe(process.execPath);
        expect(owned.watchdog).toBeUndefined();
      } finally {
        await cleanupOwned([owned.server]);
        if (owned.watchdog) {
          owned.watchdog.child.stdin?.end();
          await owned.watchdog.exited;
        }
      }
    }),
  );
  // oxlint-disable-next-line goat/no-global-process-runtime -- Process groups are unavailable on Windows.
  it.live.skipIf(process.platform === "win32")(
    "kills the server group after a SIGKILLed driver (#2468)",
    () =>
      Effect.promise(async () => {
        const moduleUrl = new URL("./cpuPressureSoak.ts", import.meta.url).href;
        const serverCode = `const {spawn} = require("node:child_process"); const c = spawn(process.execPath, ["-e", "process.stdin.resume()"], {stdio:["pipe","ignore","ignore"]}); c.once("spawn", () => console.log(c.pid)); process.stdin.resume();`;
        const driverCode = `const m = await import(${JSON.stringify(moduleUrl)}); const owned = await m.spawnWatchedServer(process.execPath, ["-e", ${JSON.stringify(serverCode)}], {stdio:["pipe","pipe","ignore"]}, 1); const lines = (await import("node:readline")).createInterface({input:owned.server.child.stdout})[Symbol.asyncIterator](); const grandchild = (await lines.next()).value; console.log("fixture-ready " + owned.server.child.pid + " " + grandchild); process.stdin.resume();`;
        const driver = guardChild(
          NodeChildProcess.spawn(process.execPath, ["--input-type=module", "-e", driverCode], {
            stdio: ["pipe", "pipe", "pipe"],
          }),
          () => {},
        );
        const exited = new Promise<NodeJS.Signals | null>((resolve) =>
          driver.once("exit", (_, signal) => resolve(signal)),
        );
        const lines = NodeReadline.createInterface({ input: driver.stdout })[
          Symbol.asyncIterator
        ]();
        let pgid: number | undefined;
        const failures: unknown[] = [];
        try {
          const line = await lines.next();
          expect(line.done).toBe(false);
          expect(line.value).toMatch(/^fixture-ready \d+ \d+$/);
          pgid = Number((line.value as string).split(" ")[1]);
          driver.kill("SIGKILL");
          expect(await exited).toBe("SIGKILL");
          expect((await lines.next()).done).toBe(true);
          expect(() => process.kill(-pgid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
        } catch (error) {
          failures.push(error);
        }
        try {
          if (driver.exitCode === null && driver.signalCode === null) driver.kill("SIGKILL");
          await exited;
        } catch (error) {
          failures.push(error);
        }
        if (pgid !== undefined) {
          try {
            process.kill(-pgid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") failures.push(error);
          }
        }
        if (failures.length) throw failures[0];
      }),
  );

  it("routes only termination signals to cleanup and removes the handlers", () => {
    const emitter = new NodeEvents.EventEmitter();
    const reasons: string[] = [];
    const remove = installSignalHandlers(emitter, (reason) => reasons.push(reason));
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) emitter.emit(signal);
    expect(reasons).toEqual([
      "driver received SIGINT",
      "driver received SIGTERM",
      "driver received SIGHUP",
    ]);
    expect(emitter.listenerCount("uncaughtException")).toBe(0);
    expect(emitter.listenerCount("unhandledRejection")).toBe(0);
    remove();
    expect(emitter.listenerCount("SIGTERM")).toBe(0);
  });
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
  it("enforces minimum cohort and duration only in acceptance mode", () => {
    const args = ["--home", "/tmp/home", "--report", "/tmp/report", "--server-port", "3333"];
    expect(parseArgs([...args, "--acceptance"]).acceptance).toBe(true);
    for (const extra of [
      ["--replay-threads", "119"],
      ["--headless-clients", "19"],
      ["--duration-ms", "1799999"],
    ]) {
      expect(() => parseArgs([...args, "--acceptance", ...extra])).toThrow();
      expect(parseArgs([...args, ...extra]).acceptance).toBe(false);
    }
  });

  it("refuses homes and databases that escape the checkout through symlinks", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-home-"));
    const checkout = NodePath.join(dir, "checkout");
    const home = NodePath.join(checkout, ".goat");
    try {
      NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
      const database = NodePath.join(home, "userdata", "statev2.sqlite");
      const db = new NodeSqlite.DatabaseSync(database);
      db.exec(
        "CREATE TABLE projection_projects(id TEXT); INSERT INTO projection_projects VALUES ('seed');",
      );
      db.close();
      expect(validateHome(home, checkout)).toBe(home);
      NodeFS.symlinkSync(
        NodePath.join(dir, "outside"),
        NodePath.join(home, "userdata", "settings-link"),
      );
      expect(() => validateHome(home, checkout)).toThrow();
      NodeFS.unlinkSync(NodePath.join(home, "userdata", "settings-link"));
      NodeFS.writeFileSync(NodePath.join(dir, "outside"), "outside");
      NodeFS.linkSync(
        NodePath.join(dir, "outside"),
        NodePath.join(home, "userdata", "settings-hardlink"),
      );
      expect(() => validateHome(home, checkout)).toThrow();
      NodeFS.unlinkSync(NodePath.join(home, "userdata", "settings-hardlink"));
      const empty = new NodeSqlite.DatabaseSync(database);
      empty.exec("DELETE FROM projection_projects");
      empty.close();
      expect(() => validateHome(home, checkout)).toThrow("seeded project");
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
